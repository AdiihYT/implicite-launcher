// =====================================================================
//  Első indításos baseline beállítások a CDN-ről
// ---------------------------------------------------------------------
//  A `defaults.json` manifest tartalmaz egy entries[] listát, ahol
//  minden entry-nek egyedi `id`-je van. Az APP_DIR-ben tárolt
//  `defaults-state.json` jegyzi, hogy mely id-ket alkalmaztuk már —
//  minden id csak EGYSZER fut le. Ha a játékos törli a fájlt vagy
//  módosítja, a launcher TÖBBÉ nem nyúl hozzá.
//
//  Új baseline-t úgy publikálsz, hogy a manifestben az adott entry
//  id-jét bumpolod (pl. options-v1 → options-v2). Az új id még nincs
//  applied[]-ben, így a következő indításnál FELÜLÍRJA a játékos
//  módosítását. Csak indokoltan használd.
//
//  Entry típusok:
//    - type: "file" → MC_DIR/<dest> helyre kerül egyetlen fájlként
//    - type: "zip"  → MC_DIR/<dest> mappába kicsomagolva
// =====================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const logger = require('./logger');
const { fetchJSON, downloadFile } = require('./downloader');
const zip = require('./zip');

const DEFAULTS_MANIFEST_URL = 'https://cdn.happylab.hu/implicite/defaults/defaults.json';

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readState(stateFile) {
  try {
    if (!fs.existsSync(stateFile)) return { applied: [] };
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return { applied: Array.isArray(raw.applied) ? raw.applied : [] };
  } catch (e) {
    logger.warn(`DEFAULTS: state olvasási hiba (${e.message}) – újrakezdjük`);
    return { applied: [] };
  }
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function verifySha256(filePath, expected) {
  if (!expected) return;
  const actual = await sha256File(filePath);
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`SHA256 mismatch (várt ${expected}, kapott ${actual})`);
  }
}

async function applyFileEntry(entry, mcDir, cacheDir) {
  const dest = path.join(mcDir, entry.dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const tmp = path.join(cacheDir, `${entry.id}.tmp`);
  await downloadFile(entry.url, tmp);

  try {
    await verifySha256(tmp, entry.sha256);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }

  fs.renameSync(tmp, dest);
}

// Finder Compress (macOS jobb klikk → "Compress"), és a `zip -r foo.zip foo/`
// is, mindig egy wrapper mappát tesz a tartalom köré (a forrásmappa nevével).
// Az unzip ezt változatlanul kicsomagolja, így ha `entry.dest = "resourcepacks/"`
// és a zip belsejében `resourcepacks/...` van, naiv kicsomagolásnál
// `MC_DIR/resourcepacks/resourcepacks/...` lesz az eredmény → a játék
// nem találja a tartalmat. Ezért staging-be csomagolunk és detektáljuk
// a wrappert, mielőtt a végleges helyre tennénk a tartalmat.
async function applyZipEntry(entry, mcDir, cacheDir) {
  const destDir = path.join(mcDir, entry.dest);
  fs.mkdirSync(destDir, { recursive: true });

  const tmpZip = path.join(cacheDir, `${entry.id}.zip`);
  await downloadFile(entry.url, tmpZip);

  try {
    await verifySha256(tmpZip, entry.sha256);
  } catch (e) {
    try { fs.unlinkSync(tmpZip); } catch {}
    throw e;
  }

  const staging = path.join(cacheDir, `${entry.id}-staging`);
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(staging, { recursive: true });

  // macOS-specifikus szemét kihagyása már a kicsomagolás szintjén.
  try {
    zip.extractAll(tmpZip, staging, {
      exclude: ['__MACOSX/*', '*/.DS_Store', '.DS_Store'],
    });
  } catch (e) {
    try { fs.unlinkSync(tmpZip); } catch {}
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw new Error(`kicsomagolás hibázott: ${e.message}`);
  }
  try { fs.unlinkSync(tmpZip); } catch {}

  // Wrapper-detection: ha a staging-ben pontosan egy mappa van, és annak
  // neve megegyezik a célmappa alapnevével (pl. dest="resourcepacks/" →
  // wrapper="resourcepacks"), akkor a wrapper tartalmát másoljuk fel.
  const destBaseName = path.basename(destDir);
  const stagingEntries = fs.readdirSync(staging);
  let source = staging;
  if (
    stagingEntries.length === 1 &&
    stagingEntries[0] === destBaseName &&
    fs.statSync(path.join(staging, stagingEntries[0])).isDirectory()
  ) {
    source = path.join(staging, stagingEntries[0]);
    logger.info(`DEFAULTS: wrapper "${destBaseName}/" észlelve és átlépve – ${entry.id}`);
  }

  // Tartalom másolása a végleges helyre (felülírással). Node 16.7+ fs.cpSync.
  fs.cpSync(source, destDir, { recursive: true, force: true });

  try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
}

async function ensureFirstRunDefaults({ appDir, mcDir, cacheDir, onStatus }) {
  const stateFile = path.join(appDir, 'defaults-state.json');
  const defaultsCacheDir = path.join(cacheDir, 'defaults');
  fs.mkdirSync(defaultsCacheDir, { recursive: true });

  let manifest;
  try {
    onStatus?.('Alapbeállítások ellenőrzése...');
    manifest = await fetchJSON(DEFAULTS_MANIFEST_URL);
  } catch (e) {
    // CDN elérhetetlen: ne állítsuk le a launchet emiatt — a defaults csak
    // convenience, a játékos vanilla MC defaults-szal is be tud lépni.
    logger.warn(`DEFAULTS: manifest nem elérhető (${e.message}), kihagyás`);
    return;
  }

  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!entries.length) {
    logger.info('DEFAULTS: üres manifest');
    return;
  }

  const state = readState(stateFile);
  const applied = new Set(state.applied);

  const todo = entries.filter((e) => e?.id && !applied.has(e.id));
  if (!todo.length) {
    logger.info(`DEFAULTS: minden entry már alkalmazva (${entries.length})`);
    return;
  }

  onStatus?.(`Alapbeállítások telepítése (${todo.length} db)...`);
  logger.info(`DEFAULTS: ${todo.length}/${entries.length} entry alkalmazandó`);

  for (const entry of todo) {
    try {
      if (!entry.url || !entry.dest || !entry.type) {
        throw new Error('hiányos entry mezők (url/dest/type)');
      }
      if (entry.type === 'file') {
        await applyFileEntry(entry, mcDir, defaultsCacheDir);
      } else if (entry.type === 'zip') {
        await applyZipEntry(entry, mcDir, defaultsCacheDir);
      } else {
        throw new Error(`ismeretlen type: ${entry.type}`);
      }
      applied.add(entry.id);
      // Inkrementális mentés: félbeszakadás esetén a sikeres entry-k megmaradnak.
      saveState(stateFile, { applied: Array.from(applied) });
      logger.info(`DEFAULTS: ✓ ${entry.id} → ${entry.dest}`);
    } catch (e) {
      // Egy hibás entry sose blokkolja a launchet — csak warn és tovább.
      logger.warn(`DEFAULTS: ✗ ${entry.id} sikertelen – ${e.message}`);
    }
  }
}

module.exports = {
  ensureFirstRunDefaults,
  DEFAULTS_MANIFEST_URL,
};
