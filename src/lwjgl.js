// =====================================================================
//  macOS arm64 LWJGL 2 fix a Minecraft 1.8.9-hez
// ---------------------------------------------------------------------
//  Apple Silicon Mac + macOS Tahoe (és nem csak Tahoe) alatt a vanilla
//  LWJGL 2.9.x egyszerre két okból nem működik MC 1.8.9-cel:
//
//    1) A natív dylib-ben hiányzik az arm64 slice.
//    2) Még ha be is rakjuk a MinecraftMachina arm64 buildjét, az csak akkor
//       működik, ha NINCS `-XstartOnFirstThread`. (A patch dispatch_sync-et
//       hív a main queue-ra; ha a JVM main thread MÁR a main queue,
//       a sync deadlock-ol vagy némán semmit sem tesz, így a GL context
//       sose lesz current és a `glGetString(GL_VERSION)` null-t ad.)
//    3) A Java oldali LWJGL 2.9.4 osztályok is patched verziót igényelnek
//       (ByteBuffer/Buffer cast-ok modern JVM-en, eltávolított macOS API-k
//       JNI shimjei). Stock Maven LWJGL 2.9.4 + patched native nem
//       kompatibilis.
//
//  Megoldás (ez fut Lunar Client, Hyperium, HMCL stb. alatt is):
//    A Shadowfacts/Tanmay által patched LWJGL build használata:
//      * lwjglfat.jar     – cseréli a vanilla lwjgl.jar-t (fat: minden
//                            LWJGL osztály + jinput shim benne)
//      * lwjgl_util.jar   – patched
//      * openal.jar       – elérhetővé teszi az OpenAL Java API-t
//      * liblwjgl.dylib   – arm64 + dispatch_sync(main) AppKit wrappers
//      * libopenal.dylib  – arm64
//      * libjcocoa.dylib  – JNI shim a régen eltávolított macOS API-khoz
//
//  Forrás: github.com/GreeniusGenius/m1-prism-launcher-hack-1.8.9
//          (a Tanmay buildek hivatalos tükre)
//
//  A megoldás csak macOS arm64-en aktív; egyéb platformokon a launcher.js
//  a vanilla LWJGL 2.9.x pipeline-on megy tovább.
// =====================================================================

const TANMAY_BASE = 'https://github.com/GreeniusGenius/m1-prism-launcher-hack-1.8.9/raw/master';

const TANMAY_JARS = [
  { name: 'lwjglfat.jar',   relPath: 'org/lwjgl2compat/lwjglfat/2.9.4-tanmay/lwjglfat.jar',   url: `${TANMAY_BASE}/lwjglfat.jar` },
  { name: 'lwjgl_util.jar', relPath: 'org/lwjgl2compat/lwjgl_util/2.9.4-tanmay/lwjgl_util.jar', url: `${TANMAY_BASE}/lwjgl_util.jar` },
  { name: 'openal.jar',     relPath: 'org/lwjgl2compat/openal/2.9.4-tanmay/openal.jar',         url: `${TANMAY_BASE}/openal.jar` },
];

const TANMAY_DYLIBS = [
  { name: 'liblwjgl.dylib',   url: `${TANMAY_BASE}/lwjglnatives/liblwjgl.dylib` },
  { name: 'libopenal.dylib',  url: `${TANMAY_BASE}/lwjglnatives/libopenal.dylib` },
  { name: 'libjcocoa.dylib',  url: `${TANMAY_BASE}/lwjglnatives/libjcocoa.dylib` },
];

function isMacArm64(arch) {
  return process.platform === 'darwin' && arch === 'arm64';
}

// Az ide érkező vanilla 1.8.9 version JSON-ban a libraries[] tartalmaz LWJGL
// és jinput entryket. macOS arm64-en MIND ki, mert mindent a Tanmay JAR-ok
// adnak. Egyéb platformokon érintetlen marad.
function isLwjglOrJinputLib(name) {
  if (!name || typeof name !== 'string') return false;
  const [group] = name.split(':');
  return group === 'org.lwjgl.lwjgl' || group === 'net.java.jinput' || group === 'net.java.jutils';
}

function patchVersionForMacArm64(versionJson, arch) {
  if (!isMacArm64(arch)) return { versionJson, removedCount: 0 };
  const before = (versionJson.libraries || []).length;
  const libraries = (versionJson.libraries || []).filter((l) => !isLwjglOrJinputLib(l.name));
  return {
    versionJson: { ...versionJson, libraries },
    removedCount: before - libraries.length,
  };
}

module.exports = {
  TANMAY_JARS,
  TANMAY_DYLIBS,
  isMacArm64,
  isLwjglOrJinputLib,
  patchVersionForMacArm64,
};
