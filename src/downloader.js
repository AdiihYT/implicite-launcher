const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('./logger');
const { rewriteUrl } = require('./cdn');

const USER_AGENT = 'Implicite-Launcher/1.0';
const MAX_REDIRECTS = 8;

// Retry policy: 3 próbálkozás, 500ms → 1500ms → 4500ms backoff. Csak
// átmeneti hibákra (5xx, 408, 429, ECONNRESET stb.), 4xx-re nem.
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function pickClient(urlString) {
  return urlString.startsWith('http://') ? http : https;
}

function buildRequestOpts(urlString) {
  const u = new URL(urlString);
  return {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + (u.search || ''),
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
  };
}

function isTransientError(err) {
  const msg = err?.message || '';
  const code = err?.code || '';
  if (/HTTP 5\d\d/.test(msg)) return true;
  if (/HTTP 408/.test(msg) || /HTTP 429/.test(msg)) return true;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN'  || code === 'ENOTFOUND' || code === 'EPIPE') return true;
  if (/socket hang up/i.test(msg)) return true;
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === RETRY_ATTEMPTS) throw err;
      const delay = RETRY_BASE_DELAY_MS * Math.pow(3, attempt - 1);
      logger.warn(`RETRY ${label || ''}: ${err.message} – ${delay}ms múlva újra (${attempt + 1}/${RETRY_ATTEMPTS})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function fetchJSONOnce(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error(`Túl sok redirect: ${url}`));
    const req = pickClient(url).request(buildRequestOpts(url), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return fetchJSONOnce(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} – ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(`JSON parse hiba (${url}): ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchBufferOnce(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error(`Túl sok redirect: ${url}`));
    const req = pickClient(url).request(buildRequestOpts(url), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return fetchBufferOnce(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} – ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

function downloadFileOnce(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error(`Túl sok redirect: ${url}`));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';

    const req = pickClient(url).request(buildRequestOpts(url), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return downloadFileOnce(next, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} – ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const out = fs.createWriteStream(tmp);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total) onProgress(received / total);
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(tmp, dest);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
      out.on('error', (e) => {
        try { fs.unlinkSync(tmp); } catch {}
        reject(e);
      });
    });
    req.on('error', (e) => {
      try { fs.unlinkSync(tmp); } catch {}
      reject(e);
    });
    req.end();
  });
}

function fetchJSON(url) {
  const target = rewriteUrl(url);
  return withRetry(() => fetchJSONOnce(target), `fetchJSON ${target}`);
}

function fetchBuffer(url) {
  const target = rewriteUrl(url);
  return withRetry(() => fetchBufferOnce(target), `fetchBuffer ${target}`);
}

function downloadFile(url, dest, onProgress) {
  const target = rewriteUrl(url);
  return withRetry(() => downloadFileOnce(target, dest, onProgress), `downloadFile ${target}`);
}

async function downloadConcurrent(tasks, concurrency = 16) {
  const queue = [...tasks];
  const n = Math.min(concurrency, Math.max(queue.length, 1));
  const workers = Array(n).fill(null).map(async () => {
    while (queue.length) {
      const task = queue.shift();
      if (!task) continue;
      try {
        await task();
      } catch (err) {
        logger.warn(`DOWNLOAD: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
}

module.exports = { fetchJSON, fetchBuffer, downloadFile, downloadConcurrent };
