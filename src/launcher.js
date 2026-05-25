const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const logger = require('./logger');
const { fetchJSON, downloadFile, downloadConcurrent } = require('./downloader');
const lwjgl = require('./lwjgl');
const forge = require('./forge');
const defaults = require('./defaults');
const zip = require('./zip');
const cdn = require('./cdn');

// ----- útvonalak ---------------------------------------------------
const APP_DIR     = logger.APP_DIR;
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const JAVA_DIR    = path.join(APP_DIR, 'java');
const CACHE_DIR   = path.join(APP_DIR, 'cache');
const FORGE_CACHE = path.join(CACHE_DIR, 'forge');
const MC_DIR      = path.join(APP_DIR, 'minecraft');
const VERSIONS_DIR  = path.join(MC_DIR, 'versions');
const LIBRARIES_DIR = path.join(MC_DIR, 'libraries');
const ASSETS_DIR    = path.join(MC_DIR, 'assets');
const NATIVES_DIR   = path.join(MC_DIR, 'natives', '1.8.9');

const MC_VERSION = '1.8.9';
const MODS_MANIFEST_URL = 'https://cdn.happylab.hu/implicite/mods/mods.json';
const MODS_DIR = path.join(MC_DIR, 'mods');

// Készíts standard MC alkönyvtárakat
function ensureMcDirs() {
  for (const sub of ['saves', 'mods', 'resourcepacks', 'screenshots', 'logs', 'versions', 'libraries', 'assets']) {
    fs.mkdirSync(path.join(MC_DIR, sub), { recursive: true });
  }
  fs.mkdirSync(NATIVES_DIR, { recursive: true });
  fs.mkdirSync(JAVA_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ----- config / settings -------------------------------------------
function getConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    logger.warn(`CONFIG: olvasási hiba – ${e.message}`);
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    logger.warn(`CONFIG: írási hiba – ${e.message}`);
  }
}

// Max RAM = a gépen elérhető fizikai memória fele, GB-ban, legalább 1.
function computeMaxRamGB() {
  const totalGB = Math.floor(os.totalmem() / (1024 ** 3));
  return Math.max(1, Math.floor(totalGB / 2));
}

function clampRam(value, maxRam) {
  let v = typeof value === 'number' ? value : 4;
  if (v < 1) v = 1;
  if (v > maxRam) v = maxRam;
  return v;
}

// Vanilla MC alapérték (--width / --height default a `--server` nélküli launcherben).
const DEFAULT_RESOLUTION = { width: 854, height: 480 };
const RES_MIN = { width: 320, height: 240 };
const RES_MAX = { width: 7680, height: 4320 };

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeResolution(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_RESOLUTION };
  return {
    width:  clampInt(value.width,  RES_MIN.width,  RES_MAX.width,  DEFAULT_RESOLUTION.width),
    height: clampInt(value.height, RES_MIN.height, RES_MAX.height, DEFAULT_RESOLUTION.height),
  };
}

function getSettings() {
  const cfg = getConfig();
  const maxRam = computeMaxRamGB();
  return {
    username:         typeof cfg.username === 'string' ? cfg.username : null,
    ram:              clampRam(cfg.ram, maxRam),
    maxRam,
    keepLauncherOpen: !!cfg.keepLauncherOpen,
    resolution:       normalizeResolution(cfg.resolution),
    fullscreen:       !!cfg.fullscreen,
    lockAspectRatio:  !!cfg.lockAspectRatio,
  };
}

function saveSettings(settings) {
  const current = getConfig();
  const maxRam = computeMaxRamGB();
  const incomingRam = typeof settings.ram === 'number' ? settings.ram : current.ram;
  const incomingRes = settings.resolution !== undefined ? settings.resolution : current.resolution;
  const next = {
    ...current,
    username:         settings.username ?? null,
    ram:              clampRam(incomingRam, maxRam),
    keepLauncherOpen: !!settings.keepLauncherOpen,
    resolution:       normalizeResolution(incomingRes),
    fullscreen:       !!settings.fullscreen,
    lockAspectRatio:  !!settings.lockAspectRatio,
  };
  saveConfig(next);
}

// ----- offline UUID (Java UUID.nameUUIDFromBytes kompatibilis) -----
function offlineUUID(username) {
  const hash = crypto.createHash('md5')
    .update(Buffer.from(`OfflinePlayer:${username}`, 'utf8'))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ----- argument helpers --------------------------------------------
function replaceAll(str, map) {
  let s = String(str);
  for (const [k, v] of Object.entries(map)) {
    s = s.split(k).join(v);
  }
  return s;
}

// ----- library rules (vanilla 1.8.9 stílus) ------------------------
function shouldIncludeLibrary(lib) {
  if (!lib.rules) return true;
  let allowed = false;
  for (const rule of lib.rules) {
    let matches = true;
    if (rule.os) {
      const osName = rule.os.name;
      if (osName === 'osx' || osName === 'macos') matches = process.platform === 'darwin';
      else if (osName === 'windows') matches = process.platform === 'win32';
      else if (osName === 'linux') matches = process.platform === 'linux';
      else matches = false;
    }
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

// ----- Java 8 telepítés (Azul Zulu) --------------------------------
// Az Adoptium nem ad ki Java 8-at macOS arm64-re. A Zulu igen (natívan),
// és x64-re Mac-en + Windows x64-en is.
// Zulu struktúra Mac-en: <top>/zulu-8.jre/Contents/Home/bin/java
// Zulu struktúra Win-en: <top>/zulu-8...-win_x64/bin/java.exe
function findJavaBinary(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 5) return null;
  const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
  const direct = path.join(dir, 'bin', javaName);
  if (fs.existsSync(direct)) return direct;
  // macOS bundle layout
  const homeBin = path.join(dir, 'Contents', 'Home', 'bin', javaName);
  if (fs.existsSync(homeBin)) return homeBin;

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findJavaBinary(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function ensureJava8(onStatus, onProgress) {
  onStatus?.('Java ellenőrzése...');
  const existing = findJavaBinary(JAVA_DIR);
  if (existing) {
    logger.info(`JAVA: megvan – ${existing}`);
    return existing;
  }

  const isWin = process.platform === 'win32';
  const archiveType = isWin ? 'zip' : 'tar.gz';
  const javaUrl = cdn.getJavaUrl();
  const archivePath = path.join(CACHE_DIR, `jre8-${process.arch}.${archiveType}`);

  onStatus?.('Java letöltése...');
  logger.info(`JAVA: CDN letöltés – ${javaUrl}`);
  await downloadFile(javaUrl, archivePath, (p) => onProgress?.('Java letöltése', p));

  onStatus?.('Java telepítése...');
  if (isWin) {
    try {
      zip.extractAll(archivePath, JAVA_DIR);
    } catch (e) {
      throw new Error('Java 8 kibontás sikertelen: ' + e.message);
    }
  } else {
    const res = spawnSync('tar', ['-xzf', archivePath, '-C', JAVA_DIR], { stdio: 'ignore' });
    if (res.status !== 0) throw new Error('Java 8 kibontás sikertelen (tar exit ' + res.status + ')');
  }

  try { fs.unlinkSync(archivePath); } catch {}

  const javaPath = findJavaBinary(JAVA_DIR);
  if (!javaPath) throw new Error('Java 8 kibontva, de a java binary nem található.');
  if (!isWin) { try { fs.chmodSync(javaPath, 0o755); } catch {} }
  logger.info(`JAVA: telepítve – ${javaPath}`);
  return javaPath;
}

// ----- vanilla 1.8.9 version JSON ----------------------------------
// Közvetlenül a CDN-tükörről jön, a Mojang version_manifest.json-t
// kihagyjuk (egy fetch-csel kevesebb, kevesebb támadási felület).
async function getVanillaVersionJson(onStatus) {
  const cacheDir = path.join(VERSIONS_DIR, MC_VERSION);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, `${MC_VERSION}.json`);
  if (fs.existsSync(cached)) {
    try { return JSON.parse(fs.readFileSync(cached, 'utf8')); } catch {}
  }
  onStatus?.('Minecraft adatok lekérése...');
  const json = await fetchJSON(cdn.URLS.vanillaVersionJson);
  fs.writeFileSync(cached, JSON.stringify(json, null, 2));
  return json;
}

// ----- vanilla client JAR ------------------------------------------
async function ensureVanillaClientJar(versionJson, onStatus, onProgress) {
  const cacheDir = path.join(VERSIONS_DIR, MC_VERSION);
  const jarPath = path.join(cacheDir, `${MC_VERSION}.jar`);
  if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 0) return jarPath;
  const url = versionJson.downloads?.client?.url;
  if (!url) throw new Error('vanilla version JSON: hiányzik downloads.client.url');
  onStatus?.('Minecraft alapfájlok letöltése...');
  await downloadFile(url, jarPath, (p) => onProgress?.('Minecraft alapfájlok', p));
  return jarPath;
}

// ----- libraries letöltése -----------------------------------------
async function ensureLibrary(lib) {
  if (!lib.downloads?.artifact?.url) return null;
  const relPath = lib.downloads.artifact.path;
  const dest = path.join(LIBRARIES_DIR, relPath);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  await downloadFile(lib.downloads.artifact.url, dest);
  return dest;
}

async function ensureForgeLibrary(task) {
  const dest = path.join(LIBRARIES_DIR, task.relPath);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  await downloadFile(task.url, dest);
  return dest;
}

// ----- natives JAR -------------------------------------------------
function nativeClassifierFor(lib) {
  if (!lib.natives) return null;
  const key = process.platform === 'darwin' ? 'osx'
            : process.platform === 'win32'  ? 'windows'
            : 'linux';
  const tmpl = lib.natives[key];
  if (!tmpl) return null;
  return tmpl.replace('${arch}', process.arch === 'x64' ? '64' : '32');
}

function nativeDownload(lib, classifier) {
  const cls = lib.downloads?.classifiers?.[classifier];
  if (cls?.url && cls?.path) return cls;
  // Forge-stílusú legacy natives lib: nincs `downloads`, csak `name` + opt. `url`.
  if (!lib.name) return null;
  const baseName = lib.name + ':' + classifier;
  const relPath = require('./forge').mavenCoordToPath(baseName);
  const url = (lib.url ? lib.url.replace(/\/+$/, '/') : 'https://libraries.minecraft.net/') + relPath;
  return { path: relPath, url };
}

async function ensureNativeJar(lib) {
  const cls = nativeClassifierFor(lib);
  if (!cls) return null;
  const info = nativeDownload(lib, cls);
  if (!info?.url || !info?.path) return null;
  const dest = path.join(LIBRARIES_DIR, info.path);
  if (!(fs.existsSync(dest) && fs.statSync(dest).size > 0)) {
    await downloadFile(info.url, dest);
  }
  return dest;
}

function extractNativesJar(jarPath) {
  try {
    zip.extractAll(jarPath, NATIVES_DIR, {
      exclude: ['META-INF/*', 'module-info.class'],
    });
  } catch (e) {
    throw new Error(`natives kibontás sikertelen: ${path.basename(jarPath)} – ${e.message}`);
  }
}

// ----- asset index + objects ---------------------------------------
async function ensureAssets(versionJson, onStatus, onProgress) {
  const ai = versionJson.assetIndex;
  if (!ai?.url) throw new Error('vanilla version JSON: hiányzik assetIndex.url');
  const indexDir = path.join(ASSETS_DIR, 'indexes');
  const objectsDir = path.join(ASSETS_DIR, 'objects');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(objectsDir, { recursive: true });

  const indexPath = path.join(indexDir, `${ai.id}.json`);
  if (!fs.existsSync(indexPath)) {
    onStatus?.('Játékelemek listájának lekérése...');
    await downloadFile(ai.url, indexPath);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const objects = index.objects || {};

  // A vanilla asset index-ben több név mutathat ugyanarra a hash-re
  // (azonos tartalom). Hash-szel dedupolunk, hogy ne legyen race ugyanazon
  // .tmp fájlra a 16-os worker-pool-ban (rename ENOENT warning).
  const seenHashes = new Set();
  const tasks = [];
  for (const info of Object.values(objects)) {
    const hash = info.hash;
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    const prefix = hash.slice(0, 2);
    const dest = path.join(objectsDir, prefix, hash);
    if (fs.existsSync(dest) && fs.statSync(dest).size === info.size) continue;
    const url = `${cdn.URLS.assetObjectsBase}/${prefix}/${hash}`;
    tasks.push(async () => { await downloadFile(url, dest); });
  }
  if (tasks.length) {
    onStatus?.(`Játékelemek letöltése (${tasks.length} fájl)...`);
    let done = 0;
    const total = tasks.length;
    const reportTasks = tasks.map((t) => async () => {
      await t();
      done++;
      onProgress?.('Játékelemek', done / total);
    });
    await downloadConcurrent(reportTasks, 16);
  }
  return ai.id;
}

// macOS Apple Silicon-on Apple OpenGL→Metal emulációja crashel MC 1.8.9
// immediate-mode rajzolásnál (`glDrawArrays_IMM_Exec` → `AppleMetalOpenGLRenderer`).
// Megoldás: kényszerítsük a VBO renderelést — ez teljesen más codepath-et használ
// MC-ben, és megkerüli a buggy immediate-mode utat.
function ensureVboOptionForMacArm64() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const optionsPath = path.join(MC_DIR, 'options.txt');
  let existing = '';
  try { existing = fs.readFileSync(optionsPath, 'utf8'); } catch {}
  const hasUseVbo = /^useVbo:/m.test(existing);
  if (hasUseVbo) {
    const next = existing.replace(/^useVbo:.*$/m, 'useVbo:true');
    if (next !== existing) fs.writeFileSync(optionsPath, next);
  } else {
    const next = (existing.endsWith('\n') || existing === '' ? existing : existing + '\n') + 'useVbo:true\n';
    fs.writeFileSync(optionsPath, next);
  }
  logger.info('OPTIONS: useVbo:true beállítva (Apple Silicon GL→Metal kerülő)');
}

// ----- Tanmay LWJGL setResizable bytecode patch -----------------------
// A MacOSXDisplay.setResizable(Z)V eredeti bytecode-ja:
//   2a 2a b4 ?? ?? 1b b7 ?? ?? b1   (aload_0; aload_0; getfield; iload_1;
//                                    invokespecial nSetResizable; return)
// Az első byte-ot (0x2a = aload_0) átírjuk 0xb1-re (return) → a metódus
// azonnal return-el, a natív nSetResizable hívás sose fut le, így az
// AppKit setStyleMask: NSException sose dobódik macOS Tahoe-n. A class
// file mérete változatlan; idempotent.
function patchTanmayLwjglSetResizable(jarPath) {
  const classRel = 'org/lwjgl/opengl/MacOSXDisplay.class';

  let buf;
  try {
    buf = zip.readEntryBuffer(jarPath, classRel);
  } catch (e) {
    throw new Error(`MacOSXDisplay.class nem olvasható: ${e.message}`);
  }

  const ORIG = [0x2a, 0x2a, 0xb4, null, null, 0x1b, 0xb7, null, null, 0xb1];
  const PATCHED = [0xb1, 0x2a, 0xb4, null, null, 0x1b, 0xb7, null, null, 0xb1];

  function findPattern(pat) {
    outer: for (let i = 0; i <= buf.length - pat.length; i++) {
      for (let j = 0; j < pat.length; j++) {
        if (pat[j] !== null && buf[i + j] !== pat[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  if (findPattern(PATCHED) !== -1) {
    logger.info('LWJGL: setResizable bytecode már patchelt');
    return;
  }

  const offset = findPattern(ORIG);
  if (offset === -1) {
    throw new Error('LWJGL setResizable bytecode pattern nem található – ismeretlen lwjglfat.jar verzió?');
  }

  buf[offset] = 0xb1;
  zip.addOrReplaceEntry(jarPath, classRel, buf);

  logger.info(`LWJGL: setResizable bytecode patchelve (offset 0x${offset.toString(16)})`);
}

// ----- Modok strict whitelisting --------------------------------------
// A felhasználó által bedobott bármilyen JAR-t kitöröljük; csak a CDN
// manifestben szereplő modok futhatnak (SHA256 ellenőrzéssel).
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function ensureMods(onStatus, onProgress) {
  fs.mkdirSync(MODS_DIR, { recursive: true });

  onStatus?.('Mod-lista lekérése...');
  let manifest;
  try {
    manifest = await fetchJSON(MODS_MANIFEST_URL);
  } catch (e) {
    throw new Error(`Mod manifest nem érhető el (${MODS_MANIFEST_URL}): ${e.message}`);
  }
  const allowedMods = Array.isArray(manifest.mods) ? manifest.mods : [];
  const allowedFilenames = new Set(allowedMods.map((m) => m.filename));

  // 1) Ismeretlen JAR-okat és nem-JAR fájlokat törlünk
  let removedCount = 0;
  try {
    for (const entry of fs.readdirSync(MODS_DIR)) {
      const full = path.join(MODS_DIR, entry);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) continue;
      if (allowedFilenames.has(entry)) continue;
      try {
        fs.unlinkSync(full);
        logger.info(`MODS: jogosulatlan fájl törölve: ${entry}`);
        removedCount++;
      } catch (e) {
        logger.warn(`MODS: nem törölhető (${entry}): ${e.message}`);
      }
    }
  } catch {}

  // 2) Hiányzó vagy hibás SHA256-os modok újratöltése
  const tasks = [];
  for (const mod of allowedMods) {
    const dest = path.join(MODS_DIR, mod.filename);
    let valid = false;
    if (fs.existsSync(dest)) {
      try {
        const stat = fs.statSync(dest);
        if (typeof mod.size !== 'number' || stat.size === mod.size) {
          const actual = await sha256File(dest);
          if (!mod.sha256 || actual.toLowerCase() === String(mod.sha256).toLowerCase()) {
            valid = true;
          } else {
            logger.warn(`MODS: SHA256 mismatch (${mod.filename}) – újratöltés`);
            try { fs.unlinkSync(dest); } catch {}
          }
        } else {
          logger.warn(`MODS: méret mismatch (${mod.filename}) – újratöltés`);
          try { fs.unlinkSync(dest); } catch {}
        }
      } catch {}
    }
    if (!valid) {
      tasks.push({ mod, dest });
    }
  }

  // Fallback URL: ha a manifestben szereplő URL 404, próbáljuk a manifest
  // mappájából ugyanazt a filenamet. A `mods.json` ott él, ahonnan a JAR-okat
  // is várjuk (a manifest URL `.../mods/mods.json` → mappa `.../mods/`).
  const manifestDir = MODS_MANIFEST_URL.replace(/\/[^/]+$/, '/');

  if (tasks.length) {
    onStatus?.(`Modok letöltése (${tasks.length} db)...`);
    let done = 0;
    const total = tasks.length;
    const dlFns = tasks.map(({ mod, dest }) => async () => {
      try {
        await downloadFile(mod.url, dest);
      } catch (err) {
        const fallbackUrl = manifestDir + mod.filename;
        if (fallbackUrl !== mod.url) {
          logger.warn(`MODS: elsődleges URL hibás (${mod.filename}: ${err.message}), fallback: ${fallbackUrl}`);
          await downloadFile(fallbackUrl, dest);
        } else {
          throw err;
        }
      }
      if (mod.sha256) {
        const actual = await sha256File(dest);
        if (actual.toLowerCase() !== String(mod.sha256).toLowerCase()) {
          try { fs.unlinkSync(dest); } catch {}
          throw new Error(`SHA256 mismatch letöltés után: ${mod.filename}`);
        }
      }
      done++;
      onProgress?.('Modok', done / total);
    });
    await downloadConcurrent(dlFns, 8);

    // Verifikáljuk, hogy ténylegesen mindegyik fájl megérkezett-e a diszkre.
    const missing = tasks
      .map((t) => t.mod.filename)
      .filter((fn) => !fs.existsSync(path.join(MODS_DIR, fn)));
    if (missing.length) {
      throw new Error(`Modok letöltése sikertelen: ${missing.join(', ')}`);
    }
    logger.info(`MODS: ${done}/${total} sikeresen letöltve`);
  }

  logger.info(`MODS: ${allowedMods.length} engedélyezett, ${removedCount} jogosulatlan törölve`);
}

// =====================================================================
//  Fő launch pipeline
// =====================================================================
async function launch({ username, ram, resolution, fullscreen, onStatus, onProgress }) {
  ensureMcDirs();

  // Defaults a useVbo enforcement ELŐTT: ha a CDN-es options.txt most kerül
  // először a helyére, a useVbo:true sor utána még biztosan rákerül arm64-en.
  await defaults.ensureFirstRunDefaults({
    appDir:   APP_DIR,
    mcDir:    MC_DIR,
    cacheDir: CACHE_DIR,
    onStatus,
  });

  ensureVboOptionForMacArm64();

  const javaPath = await ensureJava8(onStatus, onProgress);

  onStatus?.('Minecraft verzió betöltése...');
  const vanilla = await getVanillaVersionJson(onStatus);

  onStatus?.('Mod-rendszer ellenőrzése...');
  const installerPath = await forge.ensureForgeInstaller(FORGE_CACHE, onStatus);

  onStatus?.('Mod-rendszer előkészítése...');
  const forgeData = forge.readForgeProfile(installerPath);

  onStatus?.('Mod-rendszer telepítése...');
  const forgeUniversalPath = await forge.extractForgeUniversal(
    installerPath,
    LIBRARIES_DIR,
    forgeData.universalEntryName,
    forgeData.universalMavenPath,
  );
  logger.info(`FORGE: universal – ${forgeUniversalPath}`);

  // macOS arm64-en: minden vanilla LWJGL/jinput entryt elveszünk a version
  // JSON-ból; a Tanmay patched LWJGL build (lwjglfat.jar + lwjgl_util.jar +
  // openal.jar + 3 dylib) veszi át a helyét. Egyéb platformokon a vanilla
  // marad érintetlen.
  const macArm64 = lwjgl.isMacArm64(process.arch);
  const { versionJson: patchedVanilla, removedCount } =
    lwjgl.patchVersionForMacArm64(vanilla, process.arch);
  if (macArm64) {
    logger.info(`LWJGL: ${removedCount} vanilla LWJGL/jinput artefakt törölve, Tanmay LWJGL kerül helyébe`);
  }

  const vanillaClientJar = await ensureVanillaClientJar(patchedVanilla, onStatus, onProgress);

  // --- Library összegyűjtés ---
  const vanillaLibs = (patchedVanilla.libraries || []).filter(shouldIncludeLibrary);

  // Forge versionInfo libek (legacy formátum: name + opt. url).
  // Szűrések:
  //   - net.minecraftforge:forge:* — az installer-ből bontjuk ki
  //   - LWJGL és jinput — a Forge 11.15.1.2318 saját régebbi 2.9.2-t hoz
  //     magával (csak x86_64 natives-szel), ezt mellőzzük; a vanilla 1.8.9
  //     2.9.4-es verziója megy, ahol az arm64 override működik.
  const forgeLibTasks = forge.toDownloadTasks(forgeData.versionInfo.libraries)
    .filter((t) => !t.name.startsWith('net.minecraftforge:forge:'))
    .filter((t) => {
      const group = t.name.split(':')[0];
      return group !== 'org.lwjgl.lwjgl' && group !== 'net.java.jinput' && group !== 'net.java.jutils';
    });

  // --- Letöltések ---
  const allLibCount = vanillaLibs.length + forgeLibTasks.length;
  onStatus?.(`Játékkomponensek letöltése (${allLibCount} fájl)...`);
  let libDone = 0;
  const reportLib = () => { libDone++; onProgress?.('Játékkomponensek', libDone / allLibCount); };

  const vanillaDlTasks = [];
  for (const lib of vanillaLibs) {
    // 1) Sima artifact letöltés (ha van)
    vanillaDlTasks.push(async () => {
      try { await ensureLibrary(lib); } finally { reportLib(); }
    });
    // 2) Natives classifier letöltés (külön task)
    if (lib.natives) {
      vanillaDlTasks.push(async () => {
        try { await ensureNativeJar(lib); }
        catch (e) { logger.warn(`NATIVES: ${lib.name} – ${e.message}`); }
      });
    }
  }
  const forgeDlTasks = forgeLibTasks.map((t) => async () => {
    try { await ensureForgeLibrary(t); } catch (e) {
      logger.warn(`FORGE LIB: ${t.name} – ${e.message}`);
    } finally { reportLib(); }
  });
  await downloadConcurrent([...vanillaDlTasks, ...forgeDlTasks], 8);

  // --- Natives kicsomagolás ---
  onStatus?.('Rendszerkomponensek előkészítése...');
  try {
    for (const entry of fs.readdirSync(NATIVES_DIR)) {
      try { fs.rmSync(path.join(NATIVES_DIR, entry), { recursive: true, force: true }); } catch {}
    }
  } catch {}

  if (macArm64) {
    // macOS arm64-en a Tanmay dylib-eket közvetlenül a natives dir-be tesszük.
    onStatus?.('Apple Silicon támogatás letöltése...');
    for (const d of lwjgl.TANMAY_DYLIBS) {
      const dest = path.join(NATIVES_DIR, d.name);
      await downloadFile(d.url, dest);
    }
  } else {
    for (const lib of vanillaLibs) {
      if (!lib.natives) continue;
      const cls = nativeClassifierFor(lib);
      if (!cls) continue;
      const info = nativeDownload(lib, cls);
      if (!info?.path) continue;
      const jar = path.join(LIBRARIES_DIR, info.path);
      if (fs.existsSync(jar)) {
        try { extractNativesJar(jar); }
        catch (e) { logger.warn(`NATIVES extract: ${path.basename(jar)} – ${e.message}`); }
      }
    }
  }

  // macOS arm64-en a Tanmay JAR-ok letöltése a libraries dir-be.
  if (macArm64) {
    onStatus?.('Apple Silicon komponensek letöltése...');
    for (const j of lwjgl.TANMAY_JARS) {
      const dest = path.join(LIBRARIES_DIR, j.relPath);
      if (!(fs.existsSync(dest) && fs.statSync(dest).size > 0)) {
        await downloadFile(j.url, dest);
      }
    }
    // A Tanmay liblwjgl.dylib nSetResizable hívása [NSWindow setStyleMask:]-t hív,
    // ami macOS Tahoe AppKit-ben NSException-t dob → SIGABRT. Az MC vagy az
    // OptiFine fullscreen/resize toggle-jénél bukik. Megoldás: a lwjglfat.jar-ban
    // a MacOSXDisplay.setResizable(Z)V bytecode első byte-ját RETURN-re cseréljük,
    // így a natív hívás soha nem fut le. Idempotent.
    const lwjglfatPath = path.join(LIBRARIES_DIR,
      lwjgl.TANMAY_JARS.find((j) => j.name === 'lwjglfat.jar').relPath);
    onStatus?.('Apple Silicon optimalizáció...');
    patchTanmayLwjglSetResizable(lwjglfatPath);
  }

  // --- Assets ---
  const assetIndexId = await ensureAssets(patchedVanilla, onStatus, onProgress);

  // --- Modok (strict CDN whitelist) ---
  onStatus?.('Modok ellenőrzése...');
  await ensureMods(onStatus, onProgress);

  // --- Classpath felépítés ---
  // Vanilla non-native libek + Forge libek + universal JAR + MC kliens.
  // Forge libek elsőként, hogy a classloader az újabb verziókat találja meg
  // (pl. asm-all, launchwrapper) a vanilla 1.8.9 helyett.
  const classpath = [];
  const seen = new Set();
  const addCp = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p); classpath.push(p);
  };

  for (const t of forgeLibTasks) addCp(path.join(LIBRARIES_DIR, t.relPath));
  for (const lib of vanillaLibs) {
    if (lib.natives) continue;
    if (lib.downloads?.artifact?.path) addCp(path.join(LIBRARIES_DIR, lib.downloads.artifact.path));
  }
  if (macArm64) {
    for (const j of lwjgl.TANMAY_JARS) addCp(path.join(LIBRARIES_DIR, j.relPath));
  }
  addCp(forgeUniversalPath);
  addCp(vanillaClientJar);

  // --- Argument összerakás ---
  const replacements = {
    '${auth_player_name}':   username,
    '${version_name}':       MC_VERSION + '-Forge',
    '${game_directory}':     MC_DIR,
    '${assets_root}':        ASSETS_DIR,
    '${game_assets}':        ASSETS_DIR,
    '${assets_index_name}':  assetIndexId,
    '${auth_uuid}':          offlineUUID(username),
    '${auth_access_token}':  '0',
    '${auth_session}':       '0',
    '${user_type}':          'legacy',
    '${user_properties}':    '{}',
    '${natives_directory}':  NATIVES_DIR,
    '${launcher_name}':      'Implicite',
    '${launcher_version}':   '1.0.0',
    '${classpath}':          classpath.join(path.delimiter),
  };

  // 1.8.9 = legacy `minecraftArguments` string
  const gameArgsRaw = forgeData.versionInfo.minecraftArguments
    || vanilla.minecraftArguments
    || '';
  const gameArgs = forge.parseLegacyMinecraftArguments(gameArgsRaw)
    .map((a) => replaceAll(a, replacements));

  // Felbontás + fullscreen — vanilla MC `--width / --height / --fullscreen` flagek.
  // A legacy minecraftArguments-ben nincs felbontás placeholder, ezért egyszerűen
  // hozzáfűzzük a végéhez.
  const res = normalizeResolution(resolution);
  gameArgs.push('--width', String(res.width), '--height', String(res.height));
  if (fullscreen) gameArgs.push('--fullscreen');

  const xms = ram > 2 ? '1G' : '512M';
  const jvmArgs = [];
  if (process.platform === 'darwin') {
    // KRITIKUS: macOS arm64-en a Tanmay LWJGL build dispatch_sync-et hív
    // a main queue-ra. Ha `-XstartOnFirstThread` van, a JVM main thread
    // MÁR a main queue, és a sync deadlock-ol → GL context sose lesz
    // current → glGetString(GL_VERSION) null → Framebuffer crash.
    // Csak Intel macOS-en kell a flag.
    if (!macArm64) jvmArgs.push('-XstartOnFirstThread');
    jvmArgs.push(
      '-Xdock:name=Implicite',
      '-Dapple.awt.application.appearance=system',
      '-Dapple.laf.useScreenMenuBar=true',
    );
  }
  jvmArgs.push(
    `-Xmx${ram}G`,
    `-Xms${xms}`,
    `-Djava.library.path=${NATIVES_DIR}`,
    `-Dorg.lwjgl.librarypath=${NATIVES_DIR}`,
    '-Dminecraft.launcher.brand=Implicite',
    '-Dminecraft.launcher.version=1.0.0',
    '-cp', classpath.join(path.delimiter),
  );

  const mainClass = forgeData.versionInfo.mainClass || 'net.minecraft.launchwrapper.Launch';
  const fullArgs = [...jvmArgs, mainClass, ...gameArgs];

  logger.info(`SPAWN: ${javaPath} ${fullArgs.length} args, classpath items=${classpath.length}, mainClass=${mainClass}`);
  logger.debug(`SPAWN args: ${JSON.stringify(fullArgs)}`);

  onStatus?.('Minecraft indítása...');
  const gameLogPath = path.join(APP_DIR, 'game.log');
  try { fs.writeFileSync(gameLogPath, `Minecraft – ${new Date().toISOString()}\n${'-'.repeat(60)}\n`); } catch {}
  const gameLog = fs.openSync(gameLogPath, 'a');
  const mc = spawn(javaPath, fullArgs, {
    cwd: MC_DIR,
    detached: true,
    stdio: ['ignore', gameLog, gameLog],
  });

  logger.info(`SPAWN: PID=${mc.pid}, game.log=${gameLogPath}`);
  return mc;
}

module.exports = {
  getSettings,
  saveSettings,
  launch,
  offlineUUID,
  APP_DIR,
};
