const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('./logger');

const USER_AGENT = 'Implicite-Launcher/1.0';
const MAX_REDIRECTS = 8;

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

function fetchJSON(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error(`Túl sok redirect: ${url}`));
    const req = pickClient(url).request(buildRequestOpts(url), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return fetchJSON(next, redirects + 1).then(resolve, reject);
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

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error(`Túl sok redirect: ${url}`));
    const req = pickClient(url).request(buildRequestOpts(url), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return fetchBuffer(next, redirects + 1).then(resolve, reject);
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

function downloadFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error(`Túl sok redirect: ${url}`));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';

    const req = pickClient(url).request(buildRequestOpts(url), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return downloadFile(next, dest, onProgress, redirects + 1).then(resolve, reject);
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
