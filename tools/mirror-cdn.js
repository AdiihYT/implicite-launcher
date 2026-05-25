#!/usr/bin/env node
// =====================================================================
//  mirror-cdn.js — letölt mindent, ami a launcher futtatásához kell,
//  egy lokális mappába, abban a struktúrában, ahogyan a
//  cdn.happylab.hu/implicite/ alá kerülnie kell.
//
//  Használat:
//    node tools/mirror-cdn.js [staging-dir]
//
//  Default staging-dir: ./cdn-staging
//
//  A teljes letöltés ~450 MB, ~3000 fájl, és kb. 5-15 perc 1 Gbps
//  felett. A script idempotens: második futáskor csak a hiányzó
//  fájlokat tölti le újra. Bármilyen kritikus hiba esetén megáll és
//  pirossal kiírja, melyik lépés mivel hasalt el.
// =====================================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const AdmZip = require('adm-zip');

// ----- konfig --------------------------------------------------------
const STAGING = path.resolve(process.argv[2] || './cdn-staging');

const FORGE_VERSION = '1.8.9-11.15.1.2318-1.8.9';
const FORGE_INSTALLER_URL =
  `https://maven.minecraftforge.net/net/minecraftforge/forge/${FORGE_VERSION}/forge-${FORGE_VERSION}-installer.jar`;

const MC_VERSION = '1.8.9';
const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';

const TANMAY_BASE = 'https://raw.githubusercontent.com/GreeniusGenius/m1-prism-launcher-hack-1.8.9/master';
const TANMAY_FILES = [
  { url: `${TANMAY_BASE}/lwjglfat.jar`,                 dest: 'lwjgl-tanmay/lwjglfat.jar' },
  { url: `${TANMAY_BASE}/lwjgl_util.jar`,               dest: 'lwjgl-tanmay/lwjgl_util.jar' },
  { url: `${TANMAY_BASE}/openal.jar`,                   dest: 'lwjgl-tanmay/openal.jar' },
  { url: `${TANMAY_BASE}/lwjglnatives/liblwjgl.dylib`,  dest: 'lwjgl-tanmay/lwjglnatives/liblwjgl.dylib' },
  { url: `${TANMAY_BASE}/lwjglnatives/libopenal.dylib`, dest: 'lwjgl-tanmay/lwjglnatives/libopenal.dylib' },
  { url: `${TANMAY_BASE}/lwjglnatives/libjcocoa.dylib`, dest: 'lwjgl-tanmay/lwjglnatives/libjcocoa.dylib' },
];

const JAVA_PLATFORMS = [
  { os: 'macos',   arch: 'aarch64', archive: 'tar.gz', destName: 'zulu8-mac-aarch64.tar.gz' },
  { os: 'macos',   arch: 'x64',     archive: 'tar.gz', destName: 'zulu8-mac-x64.tar.gz'     },
  { os: 'windows', arch: 'x64',     archive: 'zip',    destName: 'zulu8-win-x64.zip'        },
];

const MAX_REDIRECTS = 8;
const ASSET_CONCURRENCY = 16;
const LIBRARY_CONCURRENCY = 8;

// ----- színes log ----------------------------------------------------
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  red:   '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan:  '\x1b[36m', gray:  '\x1b[90m',
};
function log(level, msg) {
  const prefix = {
    STEP: `${C.bold}${C.cyan}▶${C.reset}`,
    OK:   `${C.green}✓${C.reset}`,
    WARN: `${C.yellow}⚠${C.reset}`,
    FAIL: `${C.red}✗${C.reset}`,
    INFO: `${C.gray}·${C.reset}`,
  }[level] || level;
  console.log(`${prefix} ${msg}`);
}

// ----- stats ---------------------------------------------------------
const stats = {
  downloaded: 0,
  skipped:    0,
  bytes:      0,
  failed:     [],
};

// ----- HTTP letöltés redirect-követéssel ----------------------------
function fetchStream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error(`túl sok redirect: ${url}`));
    let u;
    try { u = new URL(url); }
    catch (e) { return reject(new Error(`érvénytelen URL: ${url}`)); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return reject(new Error(`nem támogatott protokoll: ${u.protocol}`));
    }
    const opts = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'http:' ? 80 : 443),
      path:     u.pathname + (u.search || ''),
      method:   'GET',
      headers:  { 'User-Agent': 'Implicite-CDN-Mirror/1.0', 'Accept': '*/*' },
    };
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return fetchStream(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} – ${url}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`timeout: ${url}`)));
    req.end();
  });
}

async function downloadFile(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    stats.skipped++;
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  try { fs.unlinkSync(tmp); } catch {}

  const res = await fetchStream(url);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.pipe(out);
    res.on('error', (e) => { try { out.destroy(); } catch {} reject(e); });
    out.on('error', reject);
    out.on('finish', () => out.close((e) => e ? reject(e) : resolve()));
  });
  fs.renameSync(tmp, dest);
  stats.downloaded++;
  stats.bytes += fs.statSync(dest).size;
}

async function downloadJSON(url) {
  const res = await fetchStream(url);
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end',  () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error(`JSON parse hiba (${url}): ${e.message}`)); }
    });
    res.on('error', reject);
  });
}

// ----- concurrent pool ----------------------------------------------
async function pool(tasks, concurrency, label) {
  const queue = [...tasks];
  const errors = [];
  const total = queue.length;
  let done = 0;
  const tick = () => {
    done++;
    if (total > 20 && (done % 25 === 0 || done === total)) {
      process.stdout.write(`\r${C.gray}    ${label || ''} ${done}/${total}${C.reset}    `);
    }
  };
  const workers = Array(Math.min(concurrency, total)).fill(null).map(async () => {
    while (queue.length) {
      const task = queue.shift();
      try { await task(); }
      catch (e) { errors.push(e); }
      tick();
    }
  });
  await Promise.all(workers);
  if (total > 20) process.stdout.write('\n');
  return errors;
}

// ----- maven koordináta → path --------------------------------------
function mavenCoordToPath(coord) {
  const noAt = coord.split('@')[0];
  const parts = noAt.split(':');
  let classifier = null;
  let main = noAt;
  if (parts.length === 4) {
    classifier = parts[3];
    main = parts.slice(0, 3).join(':');
  }
  const [group, artifact, version] = main.split(':');
  if (!group || !artifact || !version) throw new Error(`érvénytelen maven koord: ${coord}`);
  const cls = classifier ? `-${classifier}` : '';
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${cls}.jar`;
}

// ----- step wrapper --------------------------------------------------
async function step(name, fn) {
  log('STEP', name);
  try {
    await fn();
    log('OK', `${name} kész`);
  } catch (e) {
    log('FAIL', `${name}: ${e.message}`);
    stats.failed.push({ step: name, error: e.message });
    throw e;
  }
}

// ----- main pipeline -------------------------------------------------
async function main() {
  console.log('');
  log('STEP', `Staging directory: ${C.bold}${STAGING}${C.reset}`);
  fs.mkdirSync(STAGING, { recursive: true });
  console.log('');

  // 1) Forge installer
  let forgeInstallerPath;
  await step('1/8 Forge installer', async () => {
    forgeInstallerPath = path.join(STAGING, 'forge', `forge-${FORGE_VERSION}-installer.jar`);
    await downloadFile(FORGE_INSTALLER_URL, forgeInstallerPath);
  });

  // 2) Tanmay LWJGL (Mac arm64 patched)
  await step('2/8 Tanmay LWJGL (Mac arm64)', async () => {
    for (const f of TANMAY_FILES) {
      await downloadFile(f.url, path.join(STAGING, f.dest));
      log('INFO', `  ${f.dest}`);
    }
  });

  // 3) Vanilla version manifest + 1.8.9 version JSON
  let versionJson;
  await step('3/8 Mojang version manifest + 1.8.9.json', async () => {
    const manifest = await downloadJSON(VERSION_MANIFEST_URL);
    const manifestDir = path.join(STAGING, 'mirror');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'version_manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
    const entry = (manifest.versions || []).find((v) => v.id === MC_VERSION);
    if (!entry) throw new Error(`${MC_VERSION} nem található a Mojang manifestben`);
    log('INFO', `  1.8.9 entry URL: ${entry.url}`);
    versionJson = await downloadJSON(entry.url);
    const verDir = path.join(STAGING, 'mirror', 'versions', MC_VERSION);
    fs.mkdirSync(verDir, { recursive: true });
    fs.writeFileSync(path.join(verDir, `${MC_VERSION}.json`), JSON.stringify(versionJson, null, 2));
  });

  // 4) Vanilla client JAR
  await step('4/8 Vanilla MC client JAR', async () => {
    const url = versionJson.downloads?.client?.url;
    if (!url) throw new Error('hiányzik downloads.client.url');
    const dest = path.join(STAGING, 'mirror', 'versions', MC_VERSION, `${MC_VERSION}.jar`);
    await downloadFile(url, dest);
  });

  // 5) Vanilla libraries (sima artifact + minden platform natives)
  await step('5/8 Vanilla libraries + natives (minden platform)', async () => {
    const tasks = [];
    for (const lib of versionJson.libraries || []) {
      const art = lib.downloads?.artifact;
      if (art?.url && art?.path) {
        tasks.push(async () => {
          await downloadFile(art.url, path.join(STAGING, 'mirror', 'libraries', art.path));
        });
      }
      const cls = lib.downloads?.classifiers;
      if (cls && typeof cls === 'object') {
        for (const key of Object.keys(cls)) {
          const c = cls[key];
          if (c?.url && c?.path) {
            tasks.push(async () => {
              await downloadFile(c.url, path.join(STAGING, 'mirror', 'libraries', c.path));
            });
          }
        }
      }
    }
    log('INFO', `  ${tasks.length} library / natives entry`);
    const errors = await pool(tasks, LIBRARY_CONCURRENCY, 'libs');
    if (errors.length) {
      throw new Error(`${errors.length} library letöltés sikertelen (első: ${errors[0].message})`);
    }
  });

  // 6) Asset index + minden egyedi asset objektum
  await step('6/8 Asset index + objektumok', async () => {
    const ai = versionJson.assetIndex;
    if (!ai?.url || !ai?.id) throw new Error('hiányzik assetIndex.url vagy .id');
    const indexPath = path.join(STAGING, 'mirror', 'assets', 'indexes', `${ai.id}.json`);
    await downloadFile(ai.url, indexPath);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const objects = index.objects || {};

    const seen = new Set();
    const tasks = [];
    for (const info of Object.values(objects)) {
      if (!info?.hash || seen.has(info.hash)) continue;
      seen.add(info.hash);
      const prefix = info.hash.slice(0, 2);
      const url    = `https://resources.download.minecraft.net/${prefix}/${info.hash}`;
      const dest   = path.join(STAGING, 'mirror', 'assets', 'objects', prefix, info.hash);
      tasks.push(async () => { await downloadFile(url, dest); });
    }
    log('INFO', `  ${tasks.length} egyedi asset objektum`);
    const errors = await pool(tasks, ASSET_CONCURRENCY, 'assets');
    if (errors.length) {
      throw new Error(`${errors.length} asset letöltés sikertelen (első: ${errors[0].message})`);
    }
  });

  // 7) Forge libraries — kibontjuk az installer install_profile.json-ját
  await step('7/8 Forge libraries (installer-ből kiolvasva)', async () => {
    const zip = new AdmZip(forgeInstallerPath);
    const entry = zip.getEntry('install_profile.json');
    if (!entry) throw new Error('install_profile.json nem található a Forge installerben');
    const profile = JSON.parse(entry.getData().toString('utf8'));
    const libs = profile.versionInfo?.libraries || [];

    const tasks = [];
    const warnings = [];
    for (const lib of libs) {
      if (!lib.name) continue;
      if (lib.clientreq === false) continue;
      if (lib.name.startsWith('net.minecraftforge:forge:')) continue;

      let relPath;
      try { relPath = mavenCoordToPath(lib.name); }
      catch (e) { warnings.push(`${lib.name}: ${e.message}`); continue; }

      const baseUrl = (lib.url || 'https://libraries.minecraft.net/').replace(/\/+$/, '/');
      const url  = baseUrl + relPath;
      const dest = path.join(STAGING, 'mirror', 'libraries', relPath);
      tasks.push(async () => {
        try { await downloadFile(url, dest); }
        catch (e) {
          // Forge libek között lehet 404 (a launcher is tolerál) → csak warn
          warnings.push(`${lib.name}: ${e.message}`);
        }
      });
    }
    log('INFO', `  ${tasks.length} Forge library`);
    await pool(tasks, LIBRARY_CONCURRENCY, 'forge');
    for (const w of warnings) log('WARN', `  ${w}`);
  });

  // 8) Java 8 (Azul Zulu) — 3 platform
  await step('8/8 Java 8 JRE (Azul Zulu) — 3 platform', async () => {
    for (const p of JAVA_PLATFORMS) {
      const apiUrl =
        `https://api.azul.com/metadata/v1/zulu/packages/` +
        `?java_version=8&os=${p.os}&arch=${p.arch}` +
        `&archive_type=${p.archive}&java_package_type=jre&javafx_bundled=false` +
        `&latest=true&release_status=ga`;
      const meta = await downloadJSON(apiUrl);
      if (!Array.isArray(meta) || !meta.length) {
        throw new Error(`Azul API üres válasz: ${p.os}/${p.arch}`);
      }
      const url = meta[0].download_url;
      if (!url) throw new Error(`Azul API hiányzó download_url: ${p.os}/${p.arch}`);
      const dest = path.join(STAGING, 'java', p.destName);
      await downloadFile(url, dest);
      log('INFO', `  ${p.destName} ← ${meta[0].name || '?'}`);
    }
  });

  // ----- záró összegzés ---------------------------------------------
  console.log('');
  console.log(`${C.bold}${C.green}═══════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.green}  MINDEN LETÖLTÉS KÉSZ${C.reset}`);
  console.log(`${C.bold}${C.green}═══════════════════════════════════════════════════${C.reset}`);
  console.log(`  Letöltve:    ${C.bold}${stats.downloaded}${C.reset} fájl`);
  console.log(`  Cache-elt:   ${C.gray}${stats.skipped} fájl (már megvolt)${C.reset}`);
  console.log(`  Adatmennyiség: ${C.bold}${(stats.bytes / 1024 / 1024).toFixed(1)} MB${C.reset}`);
  console.log(`  Cél mappa:   ${C.cyan}${STAGING}${C.reset}`);
  console.log('');
  console.log(`${C.bold}Feltöltés a CDN-re (példa):${C.reset}`);
  console.log(`  ${C.gray}rsync -avz --progress ${STAGING}/ user@cdn.happylab.hu:/var/www/implicite/${C.reset}`);
  console.log('');
  console.log(`${C.bold}Várt URL-ek a CDN-en (példák):${C.reset}`);
  console.log(`  ${C.gray}https://cdn.happylab.hu/implicite/forge/forge-${FORGE_VERSION}-installer.jar${C.reset}`);
  console.log(`  ${C.gray}https://cdn.happylab.hu/implicite/mirror/versions/${MC_VERSION}/${MC_VERSION}.jar${C.reset}`);
  console.log(`  ${C.gray}https://cdn.happylab.hu/implicite/mirror/libraries/org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/...${C.reset}`);
  console.log(`  ${C.gray}https://cdn.happylab.hu/implicite/mirror/assets/objects/<prefix>/<hash>${C.reset}`);
  console.log(`  ${C.gray}https://cdn.happylab.hu/implicite/lwjgl-tanmay/lwjglfat.jar${C.reset}`);
  console.log(`  ${C.gray}https://cdn.happylab.hu/implicite/java/zulu8-mac-aarch64.tar.gz${C.reset}`);
  console.log('');
}

main().catch((e) => {
  console.log('');
  console.log(`${C.bold}${C.red}═══════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.red}  MEGSZAKADT${C.reset}`);
  console.log(`${C.bold}${C.red}═══════════════════════════════════════════════════${C.reset}`);
  console.log(`  ${C.red}${e.message}${C.reset}`);
  if (stats.failed.length) {
    console.log('');
    console.log(`${C.bold}Hibás lépések:${C.reset}`);
    for (const f of stats.failed) {
      console.log(`  ${C.red}✗${C.reset} ${f.step}`);
      console.log(`     ${C.gray}${f.error}${C.reset}`);
    }
  }
  console.log('');
  console.log(`${C.yellow}Megjegyzés:${C.reset} a script idempotens — egyszerűen indítsd újra,`);
  console.log(`csak a hiányzó fájlokat fogja újra megpróbálni.`);
  console.log('');
  process.exit(1);
});
