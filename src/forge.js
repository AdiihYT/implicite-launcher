// =====================================================================
//  Forge 1.8.9 (build 11.15.1.2318) profil betöltés
// ---------------------------------------------------------------------
//  Az installer JAR-ból kibontjuk az `install_profile.json`-t és a
//  universal JAR-t. A 2318-as build Maven verziója "1.8.9-11.15.1.2318-1.8.9"
//  (a hátul lévő -1.8.9 az MC version classifier — Forge-specifikus quirk).
//
//  A `install_profile.json.versionInfo` egy teljes 1.8.9-es legacy version
//  JSON (régi `minecraftArguments` string + libraries Maven URL-ekkel).
// =====================================================================

const fs = require('fs');
const path = require('path');
const { downloadFile } = require('./downloader');
const logger = require('./logger');
const zip = require('./zip');

const FORGE_VERSION = '1.8.9-11.15.1.2318-1.8.9';
const FORGE_INSTALLER_URL =
  `https://maven.minecraftforge.net/net/minecraftforge/forge/${FORGE_VERSION}/forge-${FORGE_VERSION}-installer.jar`;

// (ZIP-műveletek cross-platform módon a `./zip` modulban — adm-zip alapon.)

async function ensureForgeInstaller(cacheDir, onStatus) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const installerPath = path.join(cacheDir, `forge-${FORGE_VERSION}-installer.jar`);
  if (fs.existsSync(installerPath) && fs.statSync(installerPath).size > 0) {
    return installerPath;
  }
  if (onStatus) onStatus('Forge installer letöltése...');
  logger.info(`FORGE: installer letöltés – ${FORGE_INSTALLER_URL}`);
  await downloadFile(FORGE_INSTALLER_URL, installerPath);
  return installerPath;
}

/**
 * @returns {{
 *   profile: object,
 *   versionInfo: object,
 *   universalEntryName: string,
 *   universalMavenPath: string,
 *   universalArtifactName: string,
 * }}
 */
function readForgeProfile(installerPath) {
  const profile = zip.readEntryJson(installerPath, 'install_profile.json');

  if (!profile.versionInfo) {
    throw new Error('install_profile.json: hiányzik a versionInfo (nem klasszikus Forge formátum?)');
  }
  if (!profile.install) {
    throw new Error('install_profile.json: hiányzik az install blokk');
  }

  const universalEntryName = profile.install.filePath;
  if (!universalEntryName) {
    throw new Error('install_profile.json.install.filePath hiányzik');
  }
  const universalArtifactName = profile.install.path;
  if (!universalArtifactName) {
    throw new Error('install_profile.json.install.path hiányzik');
  }

  const universalMavenPath = mavenCoordToPath(universalArtifactName);

  return {
    profile,
    versionInfo: profile.versionInfo,
    universalEntryName,
    universalMavenPath,
    universalArtifactName,
  };
}

async function extractForgeUniversal(installerPath, librariesDir, universalEntryName, universalMavenPath) {
  const dest = path.join(librariesDir, universalMavenPath);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  zip.extractEntry(installerPath, universalEntryName, dest);
  return dest;
}

function mavenCoordToPath(coord) {
  const [main, classifier] = coord.split('@')[0].split(':').length === 4
    ? [coord.split(':').slice(0, 3).join(':'), coord.split(':')[3]]
    : [coord, null];
  const parts = main.split(':');
  if (parts.length < 3) throw new Error(`Érvénytelen maven koord: ${coord}`);
  const [group, artifact, version] = parts;
  const cls = classifier ? `-${classifier}` : '';
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${cls}.jar`;
}

function mavenCoordToUrl(coord, baseUrl) {
  const base = (baseUrl || 'https://libraries.minecraft.net/').replace(/\/+$/, '/');
  return base + mavenCoordToPath(coord);
}

/**
 * 1.8.9-es Forge `versionInfo.libraries` formátum:
 *   { name: "group:artifact:version", url?: "https://maven.minecraftforge.net/" }
 *   Ha nincs url, a https://libraries.minecraft.net/ a default.
 *   Egyes Forge libek `serverreq: true` flag-gel jönnek és nincs client-only verziójuk —
 *   ezeket szűrjük, ha `clientreq === false`.
 */
function toDownloadTasks(libraries) {
  const out = [];
  for (const lib of libraries || []) {
    if (!lib.name) continue;
    if (lib.clientreq === false) continue;
    const url = mavenCoordToUrl(lib.name, lib.url);
    const relPath = mavenCoordToPath(lib.name);
    out.push({ name: lib.name, url, relPath });
  }
  return out;
}

function parseLegacyMinecraftArguments(str) {
  if (!str || typeof str !== 'string') return [];
  return str.split(/\s+/).filter(Boolean);
}

module.exports = {
  FORGE_VERSION,
  FORGE_INSTALLER_URL,
  ensureForgeInstaller,
  readForgeProfile,
  extractForgeUniversal,
  toDownloadTasks,
  mavenCoordToPath,
  mavenCoordToUrl,
  parseLegacyMinecraftArguments,
};
