#!/usr/bin/env node
// =====================================================================
//  generate-defaults.js
// ---------------------------------------------------------------------
//  Beolvas egy mappát, és minden benne lévő fájlból defaults.json-t
//  generál a launcher elsőindításos baseline-jához.
//
//  Használat:
//    node tools/generate-defaults.js <forrás-mappa> <cdn-base-url> [-o <kimenet>]
//
//  Példa:
//    node tools/generate-defaults.js ~/Desktop/implicite_defaults \
//         https://cdn.happylab.hu/implicite/defaults \
//         -o defaults.json
//
//  Konvenciók:
//    - *.zip fájlok kicsomagolódnak az MC_DIR egy mappájába
//      (a célmappa a ZIP_DEST_MAP-ból jön).
//    - bármi más egyetlen fájlként az MC_DIR/<filename> helyre kerül.
//    - rejtett fájlok (.DS_Store stb.) automatikusan kihagyva.
//    - ID = "<filename-extension-nélkül>-v1"; ha később új baseline
//      kell, állítsd át kézzel v2-re a manifestben → a launcher
//      újra alkalmazza az adott entry-t (és FELÜLÍRJA a játékos
//      módosítását az adott fájlon!).
// =====================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Bővítsd, ha új zip-bundle-t adsz hozzá.
const ZIP_DEST_MAP = {
  'config.zip':        'config/',
  'oneconfig.zip':     'OneConfig/',
  'resourcepacks.zip': 'resourcepacks/',
  'shaderpacks.zip':   'shaderpacks/',
};

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function inferEntry(filename) {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext);
  const id = `${base.toLowerCase()}-v1`;

  if (ext === '.zip') {
    const dest = ZIP_DEST_MAP[filename];
    if (!dest) {
      throw new Error(
        `Ismeretlen ZIP célmappa: "${filename}". Add hozzá a ZIP_DEST_MAP-hoz a scriptben.`,
      );
    }
    return { id, type: 'zip', dest };
  }

  return { id, type: 'file', dest: filename };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let outFile = 'defaults.json';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') {
      outFile = args[++i];
    } else if (args[i] === '-h' || args[i] === '--help') {
      printUsageAndExit(0);
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length < 2) printUsageAndExit(1);
  const [sourceDir, cdnBase] = positional;
  return {
    sourceDir: path.resolve(sourceDir),
    cdnBase:   cdnBase.replace(/\/+$/, ''),
    outFile:   path.resolve(outFile),
  };
}

function printUsageAndExit(code) {
  console.error(
    'Használat: node tools/generate-defaults.js <forrás-mappa> <cdn-base-url> [-o <kimenet>]\n' +
    'Példa:     node tools/generate-defaults.js ~/Desktop/implicite_defaults \\\n' +
    '              https://cdn.happylab.hu/implicite/defaults -o defaults.json',
  );
  process.exit(code);
}

function main() {
  const { sourceDir, cdnBase, outFile } = parseArgs(process.argv);

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    console.error(`Forrás mappa nem található vagy nem mappa: ${sourceDir}`);
    process.exit(1);
  }

  // A scriptet (ha a forrás mappába másolták) és a kimeneti manifestet
  // sose tegyük be a manifestbe — különben a launcher a játékos
  // minecraft mappájába írná ezeket.
  const selfName = path.basename(__filename);
  const outName  = path.basename(outFile);
  const skipExts = new Set(['.js', '.mjs', '.cjs', '.ts', '.md']);

  const files = fs.readdirSync(sourceDir)
    .filter((f) => !f.startsWith('.'))
    .filter((f) => fs.statSync(path.join(sourceDir, f)).isFile())
    .filter((f) => {
      if (f === selfName || f === outName) {
        console.log(`- ${f} (kihagyva: script/output)`);
        return false;
      }
      if (skipExts.has(path.extname(f).toLowerCase())) {
        console.log(`- ${f} (kihagyva: nem defaults asset)`);
        return false;
      }
      return true;
    })
    .sort();

  if (!files.length) {
    console.error(`Nincs feldolgozható fájl ebben: ${sourceDir}`);
    process.exit(1);
  }

  const entries = [];
  const seenIds = new Set();

  for (const f of files) {
    const full = path.join(sourceDir, f);
    const stat = fs.statSync(full);
    const sha  = sha256File(full);
    const meta = inferEntry(f);

    if (seenIds.has(meta.id)) {
      throw new Error(`Duplikált ID: ${meta.id} (${f})`);
    }
    seenIds.add(meta.id);

    entries.push({
      id:     meta.id,
      type:   meta.type,
      dest:   meta.dest,
      url:    `${cdnBase}/${encodeURIComponent(f)}`,
      size:   stat.size,
      sha256: sha,
    });

    const sizeStr = `${(stat.size / 1024).toFixed(1)} KiB`;
    console.log(
      `+ ${f.padEnd(28)} ${sizeStr.padStart(12)}  ${meta.type.padEnd(4)}  ${meta.dest.padEnd(16)}  ${sha.slice(0, 12)}…`,
    );
  }

  const manifest = { version: 1, entries };
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\n${entries.length} entry elmentve: ${outFile}`);
  console.log(`CDN base: ${cdnBase}`);
}

main();
