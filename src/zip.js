// =====================================================================
//  Cross-platform ZIP helper
// ---------------------------------------------------------------------
//  Az `unzip` shell parancs Windows-on nem létezik default-ban, ezért az
//  összes ZIP-műveletet ezen a modulon keresztül végezzük adm-zip
//  (pure JS, sync API) segítségével. Egységes API mindenhol.
// =====================================================================

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

function readEntryBuffer(jarPath, entryName) {
  const zip = new AdmZip(jarPath);
  const entry = zip.getEntry(entryName);
  if (!entry) {
    throw new Error(`ZIP entry nem található: ${entryName} (${path.basename(jarPath)})`);
  }
  return entry.getData();
}

function readEntryJson(jarPath, entryName) {
  return JSON.parse(readEntryBuffer(jarPath, entryName).toString('utf8'));
}

function extractEntry(jarPath, entryName, destPath) {
  const buf = readEntryBuffer(jarPath, entryName);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
}

// exclude: tömb stringekből; egy entry kihagyásra kerül ha a neve
// bármelyik pattern-re illeszkedik. A pattern lehet:
//   - "META-INF/*"   (prefix match a `/`-ig)
//   - "*.DS_Store"   (suffix match)
//   - "__MACOSX/*"   (prefix match)
//   - "module-info.class" (exact match)
//   - "*/.DS_Store"  (suffix match)
function entryMatchesAny(entryName, patterns) {
  if (!patterns || !patterns.length) return false;
  for (const p of patterns) {
    if (p === entryName) return true;
    // Prefix glob: "foo/*"
    if (p.endsWith('/*')) {
      const prefix = p.slice(0, -2) + '/';
      if (entryName === p.slice(0, -2) || entryName.startsWith(prefix)) return true;
    }
    // Suffix glob: "*foo"
    else if (p.startsWith('*')) {
      const suffix = p.slice(1);
      if (entryName.endsWith(suffix)) return true;
    }
  }
  return false;
}

function extractAll(jarPath, destDir, options = {}) {
  const exclude = options.exclude || [];
  fs.mkdirSync(destDir, { recursive: true });
  const zip = new AdmZip(jarPath);
  for (const entry of zip.getEntries()) {
    if (entryMatchesAny(entry.entryName, exclude)) continue;
    const outPath = path.join(destDir, entry.entryName);
    if (entry.isDirectory) {
      fs.mkdirSync(outPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, entry.getData());
  }
}

function addOrReplaceEntry(jarPath, entryName, buffer) {
  const zip = new AdmZip(jarPath);
  const existing = zip.getEntry(entryName);
  if (existing) zip.deleteFile(entryName);
  zip.addFile(entryName, buffer);
  zip.writeZip(jarPath);
}

module.exports = {
  readEntryBuffer,
  readEntryJson,
  extractEntry,
  extractAll,
  addOrReplaceEntry,
};
