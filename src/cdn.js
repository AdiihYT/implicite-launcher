// =====================================================================
//  CDN URL térkép — minden extern letöltés a happylab CDN-jéről
// ---------------------------------------------------------------------
//  Korábban a launcher közvetlenül letöltött a Mojang-tól, GitHub raw-ról,
//  maven.minecraftforge.net-ről és api.azul.com-ról. Ez (a) supply-chain
//  szempontból sok kontroll-pontot jelentett, (b) az SHA-ellenőrzés
//  hiánya mellett több MITM/repo-takeover vektort nyitott
//  (lásd SECURITY_AUDIT.md F-01, F-03).
//
//  Most minden extern letöltés a `cdn.happylab.hu/implicite/` alá megy.
//  Két szintű mechanizmus:
//
//    1) `URLS` — kódból hivatkozott statikus URL-ek (Forge installer,
//       Tanmay, Java JRE, 1.8.9 verzió JSON). Ezeket közvetlenül a
//       hívó fél használja.
//
//    2) `rewriteUrl()` — a vanilla 1.8.9 JSON tartalmából jövő URL-eket
//       (libraries.minecraft.net, resources.download.minecraft.net,
//       launcher.mojang.com client.jar, launchermeta.mojang.com asset
//       index) átírja a CDN-megfelelőjükre. Ezt a `src/downloader.js`
//       hívja minden HTTP kérés előtt.
// =====================================================================

const CDN_BASE = 'https://cdn.happylab.hu/implicite';
const MC_VERSION = '1.8.9';

// ----- statikus, kódból hivatkozott URL-ek --------------------------
const URLS = {
  // Vanilla 1.8.9 version JSON — közvetlenül a tükör, a Mojang
  // version_manifest.json lekérdezést kihagyjuk.
  vanillaVersionJson: `${CDN_BASE}/mirror/versions/${MC_VERSION}/${MC_VERSION}.json`,

  // Forge installer (pinned 1.8.9-11.15.1.2318)
  forgeInstaller:
    `${CDN_BASE}/forge/forge-1.8.9-11.15.1.2318-1.8.9-installer.jar`,

  // Tanmay LWJGL build — macOS arm64-specifikus patched 2.9.4
  tanmay: {
    base: `${CDN_BASE}/lwjgl-tanmay`,
  },

  // Asset objektumok URL-konstrukció a `rewriteUrl()`-en kívül is
  // (a `launcher.js ensureAssets()` ezzel a base-szel képzi a per-asset URL-eket)
  assetObjectsBase: `${CDN_BASE}/mirror/assets/objects`,
};

// ----- Java JRE platformonkénti pinned archívum URL-ek ---------------
const JAVA_URLS = {
  'darwin-arm64': `${CDN_BASE}/java/zulu8-mac-aarch64.tar.gz`,
  'darwin-x64':   `${CDN_BASE}/java/zulu8-mac-x64.tar.gz`,
  'win32-x64':    `${CDN_BASE}/java/zulu8-win-x64.zip`,
};

function getJavaUrl() {
  const key = `${process.platform}-${process.arch}`;
  const url = JAVA_URLS[key];
  if (!url) {
    throw new Error(`Nem támogatott platform Java letöltéshez: ${key}. Támogatott: ${Object.keys(JAVA_URLS).join(', ')}`);
  }
  return url;
}

// ----- runtime URL rewriter ------------------------------------------
//  A vanilla 1.8.9 version JSON-ja saját maga tartalmaz Mojang URL-eket
//  a libraries[], downloads.client, assetIndex mezőkben. Ezeket
//  fordítjuk a CDN-tükörhöz.
//
//  A rewriter idempotens: ha az URL már a CDN-re mutat, változatlanul
//  visszaadja.
// =====================================================================

const REWRITES = [
  // Vanilla MC libraries — libraries.minecraft.net/<group>/<artifact>/<version>/<file>.jar
  {
    pattern: /^https:\/\/libraries\.minecraft\.net\//,
    rewrite: (u) => u.replace(
      /^https:\/\/libraries\.minecraft\.net\//,
      `${CDN_BASE}/mirror/libraries/`,
    ),
  },

  // Forge maven — KIVÉTEL: a Forge installer JAR-t külön szolgáljuk ki.
  // Minden más Forge artefakt a mirror/libraries/ alatt él (a Forge
  // versionInfo.libraries `url: "https://maven.minecraftforge.net/"`-jét
  // követve, a path ugyanaz mint Maven repo-ban).
  {
    pattern: /^https:\/\/maven\.minecraftforge\.net\//,
    rewrite: (u) => {
      if (/\/forge-1\.8\.9-11\.15\.1\.2318-1\.8\.9-installer\.jar$/.test(u)) {
        return URLS.forgeInstaller;
      }
      return u.replace(
        /^https:\/\/maven\.minecraftforge\.net\//,
        `${CDN_BASE}/mirror/libraries/`,
      );
    },
  },

  // Asset objektumok — resources.download.minecraft.net/<prefix>/<hash>
  {
    pattern: /^https:\/\/resources\.download\.minecraft\.net\//,
    rewrite: (u) => u.replace(
      /^https:\/\/resources\.download\.minecraft\.net\//,
      `${URLS.assetObjectsBase}/`,
    ),
  },

  // Vanilla MC client JAR — két különböző Mojang host történelmileg
  // (launcher.mojang.com és piston-data.mojang.com)
  {
    pattern: /^https:\/\/(launcher|piston-data)\.mojang\.com\/v1\/objects\/[a-f0-9]+\/client\.jar$/,
    rewrite: () => `${CDN_BASE}/mirror/versions/${MC_VERSION}/${MC_VERSION}.jar`,
  },

  // 1.8 asset index (a vanilla version JSON `assetIndex.url` mezőjéből)
  {
    pattern: /^https:\/\/(launchermeta|piston-meta)\.mojang\.com\/v1\/packages\/[a-f0-9]+\/1\.8\.json$/,
    rewrite: () => `${CDN_BASE}/mirror/assets/indexes/1.8.json`,
  },

  // 1.8.9.json (legacy útvonal: ha valami mégis a Mojang manifesten át jönne)
  {
    pattern: /^https:\/\/(launchermeta|piston-meta)\.mojang\.com\/v1\/packages\/[a-f0-9]+\/1\.8\.9\.json$/,
    rewrite: () => URLS.vanillaVersionJson,
  },

  // Mojang version_manifest.json — szintén legacy útvonal
  {
    pattern: /^https:\/\/launchermeta\.mojang\.com\/mc\/game\/version_manifest\.json$/,
    rewrite: () => `${CDN_BASE}/mirror/version_manifest.json`,
  },

  // Tanmay LWJGL — raw.githubusercontent.com/GreeniusGenius/... → CDN
  {
    pattern: /^https:\/\/raw\.githubusercontent\.com\/GreeniusGenius\/m1-prism-launcher-hack-1\.8\.9\/master\//,
    rewrite: (u) => u.replace(
      /^https:\/\/raw\.githubusercontent\.com\/GreeniusGenius\/m1-prism-launcher-hack-1\.8\.9\/master\//,
      `${URLS.tanmay.base}/`,
    ),
  },
];

function rewriteUrl(url) {
  if (typeof url !== 'string') return url;
  for (const r of REWRITES) {
    if (r.pattern.test(url)) return r.rewrite(url);
  }
  return url;
}

module.exports = {
  CDN_BASE,
  MC_VERSION,
  URLS,
  rewriteUrl,
  getJavaUrl,
};
