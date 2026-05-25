# Implicite Launcher

A minimal, dependency-light Electron launcher for **Minecraft 1.8.9 + Forge**, built specifically to run cleanly on modern macOS — including Apple Silicon (M1/M2/M3) on macOS Tahoe — where the vanilla Mojang launcher and most third-party launchers crash on startup or during window resizing. The launcher also runs on **Windows 10 and Windows 11**, where the game has been stable across testing with no known issues so far.

The launcher has no authentication: the user types a Minecraft username, hits **START**, and the launcher handles everything else (Java install, Forge installer extraction, library/asset downloads, native unpacking, mod whitelisting, and the actual `java` spawn).

## Platform status

| Platform              | Game launch                  | Stability                                                                 | Auto-updater |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------- | ------------ |
| Windows 10 / 11       | Works without issue          | Stable — no known bugs                                                    | Yes          |
| macOS (Intel)         | Works                        | Stable                                                                    | No (unsigned DMG) |
| macOS (Apple Silicon) | Works                        | One outstanding issue: probabilistic window-resize crash in first ~10s    | No (unsigned DMG) |

### Auto-updater

The launcher ships with an auto-updater wired up through `electron-updater`. On Windows, releases are picked up automatically: the launcher checks for a newer published version on startup, downloads it in the background, and applies the update on next restart.

On macOS the auto-updater is **disabled at runtime**. `electron-updater` requires the `.dmg` (and the embedded `.app`) to be signed with a valid Developer ID certificate and notarized by Apple — otherwise Gatekeeper refuses the staged update and the install silently fails (or worse, leaves a quarantined app bundle behind). Until the project is signed with a `.cer` (Apple Developer ID Application certificate) and a notarization round-trip is added to the build, macOS users have to download new builds manually.

---

## Table of Contents

1. [Why this exists](#why-this-exists)
2. [Architecture overview](#architecture-overview)
3. [The launch pipeline, step by step](#the-launch-pipeline-step-by-step)
4. [The Java problem — and why Zulu](#the-java-problem--and-why-zulu)
5. [The LWJGL problem — and how it was solved](#the-lwjgl-problem--and-how-it-was-solved)
6. [The Apple Silicon `useVbo` quirk](#the-apple-silicon-usevbo-quirk)
7. [Mod whitelisting](#mod-whitelisting)
8. [Settings and data layout](#settings-and-data-layout)
9. [Security posture](#security-posture)
10. [Build & run](#build--run)

---

## Why this exists

Minecraft 1.8.9 was released in 2015 and shipped with **LWJGL 2.9.4-nightly-20150209**. That LWJGL build:

- has no `arm64` native slice, so it cannot load at all on Apple Silicon without translation;
- relies on a Cocoa integration path that has been progressively broken by every macOS release since Mojave (10.14);
- calls AppKit APIs (notably `[NSWindow setStyleMask:]`) in ways that throw an `NSException` on macOS Tahoe — which the JVM turns into a `SIGABRT` the moment the user resizes the window or toggles fullscreen.

Running Rosetta is not a complete answer either: the GL context regularly stalls, FPS is poor, and the resize crash is still reachable. The Implicite Launcher exists to make 1.8.9 + Forge run **natively on arm64**, **without crashing on resize**, and with the smallest possible runtime surface (zero non-Electron dependencies in production).

---

## Architecture overview

```
implicite-launcher/
├── main.js          # Electron main process — window, IPC, single-instance lock
├── preload.js       # contextBridge bridge — exposes `window.launcher.*`
├── src/
│   ├── launcher.js  # The pipeline — Java, Forge, libs, natives, assets, mods, spawn()
│   ├── downloader.js# fetchJSON / downloadFile / downloadConcurrent worker-pool
│   ├── logger.js    # File-based INFO/WARN/ERROR/DEBUG logger
│   ├── forge.js     # Forge installer JAR → install_profile.json → universal JAR extraction
│   └── lwjgl.js     # macOS arm64 LWJGL-2 swap (Tanmay/Shadowfacts build)
└── renderer/        # CSP-hardened UI shell, no external JS frameworks
```

Key design choices:

- **Zero runtime dependencies.** Everything beyond Electron itself is `fs`/`https`/`child_process`. ZIP work uses the system `unzip`/`zip` binaries via `spawnSync` — no native modules to ship, no `node-gyp` rebuilds.
- **The renderer is dumb.** No `ipcRenderer` exposure, no Node access; it only knows about `window.launcher.launch(username)`, `getSettings()`, `saveSettings()`, `forceKill()`, `openDebugLog()`, etc.
- **The main process is the source of truth.** Lifecycle, progress events, and the running Minecraft process all live in `main.js`; the renderer only renders state it receives.

### IPC surface

The preload script exposes a fixed set of named channels — nothing more:

- `get-settings` / `save-settings`
- `launch(username)` — pushes `progress` and `game-status` events back
- `force-kill` — `SIGKILL`s the Minecraft process group (negative PID, so JVM native threads die with it)
- `game-is-running`
- `open-debug-log` / `open-app-dir`

Auth/login/token channels do **not exist**; the launcher is offline-only and uses an offline UUID derived from `OfflinePlayer:<username>` via MD5 (matching Java's `UUID.nameUUIDFromBytes`).

### Window hardening

`contextIsolation: true`, `nodeIntegration: false`, `resizable: false`, DevTools auto-closed on open, zoom locked at 1.0, `Ctrl/Cmd +/-/0`, `F12`, and `Ctrl+Shift+I` intercepted via `before-input-event`. The application menu is custom-built with no View menu — there is no "Toggle DevTools" item to find. CSP in [renderer/index.html](renderer/index.html) is `default-src 'self'` with a narrow allowlist.

---

## The launch pipeline, step by step

When the user clicks START, [src/launcher.js](src/launcher.js) runs the following sequence. Each step emits a status message and (where applicable) a progress percentage back to the renderer.

1. **Directory scaffolding.** Creates `~/Library/Application Support/Implicite/{java,cache,minecraft/{saves,mods,…,natives/1.8.9}}`.
2. **`useVbo:true` enforcement** on Apple Silicon — see [The Apple Silicon `useVbo` quirk](#the-apple-silicon-usevbo-quirk).
3. **Java 8 install** via the Azul Zulu metadata API — see [The Java problem](#the-java-problem--and-why-zulu).
4. **Vanilla 1.8.9 version JSON** — fetched from Mojang's `version_manifest.json`, cached on disk.
5. **Forge installer download.** Hard-pinned to build `1.8.9-11.15.1.2318-1.8.9` (the only 1.8.9 Forge artifact that still resolves on `maven.minecraftforge.net`).
6. **Forge profile extraction.** The launcher reads `install_profile.json` directly out of the installer JAR using `unzip -p`, takes its `versionInfo` block (which is itself a legacy-format Minecraft version JSON), and uses `install.filePath` + `install.path` to locate the bundled `forge-…-universal.jar` and the Maven coordinate it should be stored under. Nothing is hardcoded — the launcher reads the coordinates out of the profile.
7. **LWJGL swap.** On macOS arm64 only: every `org.lwjgl.lwjgl:*`, `net.java.jinput:*`, and `net.java.jutils:*` entry is stripped from the vanilla libraries list before any download happens. The Tanmay LWJGL build is downloaded in its place. See [The LWJGL problem](#the-lwjgl-problem--and-how-it-was-solved).
8. **Vanilla client JAR.** `1.8.9.jar` from Mojang.
9. **Library downloads, concurrent.** Vanilla libraries (post-LWJGL-swap) + Forge libraries (filtered to skip the `forge:` artifact, which we already have from the installer, and skipping Forge's own LWJGL pull) are downloaded with a worker-pool of 8. Forge libs use the per-entry `url:` if present, otherwise fall back to `https://libraries.minecraft.net/`.
10. **Native unpacking.** Anything already in `natives/1.8.9/` is wiped first to avoid mixing LWJGL-2 and LWJGL-3 binaries. Then:
    - **macOS arm64**: download the three Tanmay `.dylib` files directly into `natives/1.8.9/`. Apply the **bytecode patch** to `lwjglfat.jar` (next section).
    - **Other platforms**: extract the vanilla natives JARs the normal way.
11. **Asset download.** `assetIndex.id === "1.8"`. The launcher iterates the index, hashes the prefix into `assets/objects/XX/XX…`, and downloads missing files with a worker-pool of 16.
12. **Mod whitelisting.** Strict CDN manifest — see [Mod whitelisting](#mod-whitelisting).
13. **Classpath assembly.** Forge libs **first** (so the classloader picks newer `asm-all`, `launchwrapper`, etc. before vanilla 1.8.9), then vanilla non-native libs, then the Tanmay JARs (arm64 only), then the Forge universal JAR, then the vanilla client JAR. A `Set` guards against duplicates.
14. **Argument assembly.** The Forge `versionInfo.minecraftArguments` legacy string is split on whitespace; placeholders like `${auth_player_name}`, `${assets_index_name}`, `${natives_directory}`, `${classpath}` are replaced. JVM args include `-Xmx${ram}G`, `-Djava.library.path`, `-Dorg.lwjgl.librarypath`, the `Implicite` brand strings, and the macOS-specific dock/menu flags.
15. **`spawn()`** — detached, `stdio` redirected into a per-launch `game.log` so JVM panics are recoverable after the fact. The Minecraft process gets its own PID group; force-kill uses negative PID so all native threads die together.

Status messages are pushed to the renderer through the `progress` IPC channel, and the renderer's launch state machine (`idle → launching → running → idle`) reacts. The `game-status` event fires when the JVM exits, so the renderer never polls.

---

## The Java problem — and why Zulu

Minecraft 1.8.9 was built for Java 8 and uses bytecode and reflective access patterns that break on Java 9+ (split classloader, `sun.misc.Unsafe` shape changes, removed AWT internals). It must be Java 8.

The obvious choice — **Eclipse Adoptium / Temurin** — does not publish a `macOS arm64` build of Java 8. Adoptium only provides arm64 binaries starting at Java 11. On an M-series Mac there is no `temurin-jdk8-aarch64-mac` URL to fetch.

There are several ways out of this:

- **Run Temurin 8 x64 under Rosetta.** Works, but you lose native performance, and on macOS Tahoe Rosetta has additional regressions with the GL/Metal layer. Rejected.
- **Use OpenJDK from Homebrew/SDKMAN.** Requires the user to install a package manager; the launcher is meant to be self-contained.
- **Use Azul Zulu.** Azul publishes a true `macos-aarch64` JRE for Java 8 (Zulu 8u372 and later). This is what the launcher uses.

### How the Zulu fetch works

The launcher hits the public Azul metadata endpoint:

`https://api.azul.com/metadata/v1/zulu/packages/?java_version=8&os=macos&arch=<aarch64|x64>&archive_type=tar.gz&java_package_type=jre&javafx_bundled=false&latest=true&release_status=ga`

The response is an array of package descriptors; the launcher picks the first one and downloads its `download_url`. The tarball extracts to a directory shaped like `zulu-8.jre/Contents/Home/bin/java`. Because that layout is non-obvious (and slightly different from Adoptium's), the launcher uses a recursive `findJavaBinary` function in [src/launcher.js](src/launcher.js#L120-L137) that walks up to 5 levels deep and probes both `bin/java` and `Contents/Home/bin/java` — so any future shape change in Zulu's distribution still resolves.

`process.arch` (`arm64` vs `x64`) is mapped to Zulu's `aarch64`/`x64` so the same code path works on both Intel and Apple Silicon Macs. Once installed, the binary is `chmod 755`'d (the tar archive sometimes preserves restrictive macOS quarantine flags) and cached forever in `~/Library/Application Support/Implicite/java/`.

---

## The LWJGL problem — and how it was solved

This is the launcher's reason for existing. The vanilla 1.8.9 LWJGL fails on Apple Silicon in three distinct ways, each requiring its own fix.

### Failure 1 — no arm64 in the native dylib

The vanilla LWJGL 2.9.4 natives JAR contains only `x86_64` slices. Loading it under arm64 Java fails immediately with an `UnsatisfiedLinkError`. A naive fix is to drop in the **MinecraftMachina** arm64 build of LWJGL 2 — but it surfaces failure 2.

### Failure 2 — `-XstartOnFirstThread` deadlocks the arm64 build

The standard macOS GLFW/LWJGL guidance says to add `-XstartOnFirstThread` so the JVM main thread is the AppKit main thread. But the patched arm64 LWJGL build calls `dispatch_sync()` onto the main queue from inside its initialization. If the JVM is **already** on the main queue (because of `-XstartOnFirstThread`), `dispatch_sync` is dispatching to itself — which either deadlocks or silently no-ops. Either way the GL context never becomes current, `glGetString(GL_VERSION)` returns `NULL`, and Minecraft crashes during `Framebuffer.checkFramebufferStatus`.

The fix is **counter-intuitive**: on macOS arm64 specifically, the launcher **omits** `-XstartOnFirstThread`. The Tanmay patched native handles the threading itself. The flag is still added on Intel macOS, where it is still required.

### Failure 3 — stock Maven LWJGL 2.9.4 Java classes are not compatible

Even with a working native, the Maven-published `lwjgl.jar` for 2.9.4 still calls JNI shims for macOS APIs that Apple removed years ago, and uses `ByteBuffer`/`Buffer` casts that throw `NoSuchMethodError` on modern JVMs (the famous Java 9 covariant return type change). The Java side of LWJGL needs to be patched too.

### The actual solution: the Tanmay/Shadowfacts build

Same approach used by Lunar Client, Hyperium, HMCL, and the Prism Launcher hack for 1.8.9. The launcher pulls a known-good set of patched JARs and dylibs from a public GitHub mirror ([`GreeniusGenius/m1-prism-launcher-hack-1.8.9`](https://github.com/GreeniusGenius/m1-prism-launcher-hack-1.8.9)):

- `lwjglfat.jar` — a "fat" LWJGL jar containing every LWJGL class plus a `jinput` shim, replacing both `lwjgl.jar` and the jinput libraries
- `lwjgl_util.jar` — patched utilities
- `openal.jar` — exposes the OpenAL Java API
- `liblwjgl.dylib` — arm64-native, with the `dispatch_sync`-aware AppKit wrappers
- `libopenal.dylib` — arm64-native OpenAL
- `libjcocoa.dylib` — JNI shims for the macOS APIs Apple removed

The full list lives in [src/lwjgl.js](src/lwjgl.js). On macOS arm64, [src/launcher.js](src/launcher.js#L530-L536) calls `lwjgl.patchVersionForMacArm64(versionJson, process.arch)`, which:

1. Walks the vanilla `libraries[]` array,
2. Removes every entry whose `group` is `org.lwjgl.lwjgl`, `net.java.jinput`, or `net.java.jutils`,
3. Returns a mutated version JSON.

Forge's own `versionInfo.libraries` is also filtered to skip the same groups, because Forge 11.15.1.2318 happens to ship its own (older, x86_64-only) LWJGL 2.9.2 references that would otherwise overwrite the Tanmay ones on the classpath.

Then the launcher downloads the Tanmay JARs into the libraries tree at synthesized Maven coordinates (`org/lwjgl2compat/lwjglfat/2.9.4-tanmay/lwjglfat.jar` and friends, so they don't collide with any real Maven artifact), and drops the three `.dylib`s straight into `natives/1.8.9/`. They are added to the classpath after the Forge libraries so the classloader finds them.

### Failure 4 — `setResizable` still throws on macOS Tahoe

This was discovered after the Tanmay build was already in place. macOS Tahoe (15.x) tightened `[NSWindow setStyleMask:]`: certain style-mask transitions that used to silently no-op now throw an `NSException`, which the JVM cannot catch, so it becomes `SIGABRT`. The native `liblwjgl.dylib`'s `nSetResizable` calls into that path; the crash reliably reproduces when toggling fullscreen or any OptiFine resize gesture.

Three options were considered:

- **Rebuild `liblwjgl.dylib`.** Possible but expensive; would mean maintaining a fork of an already-patched native.
- **Wrap the AppKit call in an `@try`/`@catch`.** Same problem — requires rebuilding the dylib.
- **Make the JVM never call into `nSetResizable` in the first place.** This is what the launcher does, and it's a one-byte fix.

The launcher applies a **JVM bytecode patch** to `lwjglfat.jar` after download. The original `org/lwjgl/opengl/MacOSXDisplay.setResizable(Z)V` method starts with the byte sequence:

```
2A 2A B4 ?? ?? 1B B7 ?? ?? B1
```

Which decodes as: `aload_0; aload_0; getfield <field>; iload_1; invokespecial nSetResizable; return`.

The launcher rewrites the first byte from `0x2A` (`aload_0`) to `0xB1` (`return`). The method now returns immediately. The native is never called. AppKit never sees the offending `setStyleMask:`. Resize and fullscreen no longer crash. The class file is the same length, so no `Code` attribute or constant pool updates are needed, and the patch is idempotent: on every launch the launcher checks for the already-patched signature first and skips re-patching if it's already done.

The patch implementation is in [src/launcher.js](src/launcher.js#L333-L380): `unzip` extracts `MacOSXDisplay.class` to a temp directory, the buffer is scanned for the pattern, the byte is rewritten, and `zip` replaces the class inside the JAR in place. If the pattern is not found (i.e. a future LWJGL build that doesn't match), the launcher throws — better to fail loudly than to silently produce a broken installation.

### Known outstanding issue — the macOS framebuffer / resize race

Even with the `nSetResizable` no-op patch in place, **macOS Apple Silicon still has one unsolved crash**: a probabilistic SIGSEGV/SIGBUS in the first 5–10 seconds after the GL window is created, triggered by resizing or full-screening the window during that startup window. We don't currently have a fix and we don't yet know exactly which layer is at fault.

What we have observed:

- **It is a startup-window race, not a steady-state bug.** If the user makes it past roughly the first 5–10 seconds — i.e. through main-menu render, into a world, with at least one resize survived — the session is stable. From that point on, resize and fullscreen can be toggled freely with no further crashes for the rest of the session. The bug does **not** reproduce mid-game.
- **The crash signature is not the old AppKit `NSException`/`SIGABRT`.** Patching out `nSetResizable` removed the deterministic `setStyleMask:` crash documented above. What's left is a different failure mode: the JVM hard-crashes with `SIGSEGV` inside `liblwjgl.dylib` or in `AppleMetalOpenGLRenderer`, with no Java stack trace, and `game.log` typically shows a partial GL initialization (`Framebuffer` / `OpenGlHelper` lines) cut off mid-write.
- **Working hypothesis.** Minecraft 1.8.9's `Framebuffer` is recreated whenever the GL viewport changes. On macOS arm64, GL calls are translated to Metal under the hood by `AppleMetalOpenGLRenderer`, and the GL context isn't fully "live" until the first frame has actually been presented. A resize during that warm-up window seems to drive `glFramebufferTexture2D` / `glCheckFramebufferStatus` against a Metal-backed FBO that hasn't been fully promoted yet, which the GL→Metal shim doesn't survive. We have not been able to definitively pin the crash to either the Tanmay-patched `liblwjgl.dylib` (LWJGL's CGL/AppKit glue) or to Apple's GL-on-Metal translation layer — both are plausible, and the crash signature is too sparse to disambiguate from the dump alone.
- **`useVbo:true` does not fix it.** The VBO option (see next section) eliminates a separate immediate-mode segfault but does nothing for this one; the framebuffer rebuild path is the same either way.
- **Workarounds considered.** Blocking input during the first N seconds (preventing the user from resizing at all) is a UX regression and only papers over the bug. Forcing a fixed window size from the JVM side is exactly what `nSetResizable` was patched to avoid touching. Forcing software GL via `LIBGL_ALWAYS_SOFTWARE`-equivalents is not really an option on macOS. Rebuilding `liblwjgl.dylib` to defer `Display.update` until the first present remains the cleanest theoretical fix, but it lands us back in fork-and-maintain-the-native territory.

For now the practical advice baked into the UI is just: **start the game, wait until you're at the main menu, then resize freely**. If the launcher survives the first ~10 seconds, the rest of the session is reliable. This is the one known bug on Apple Silicon, and we don't have a fix planned yet.

---

## The Apple Silicon `useVbo` quirk

A second arm64-only problem surfaces only after LWJGL is working: Minecraft 1.8.9 uses GL immediate mode (`glBegin`/`glEnd`/`glDrawArrays_IMM_Exec`). Under Apple's OpenGL-to-Metal compatibility layer (`AppleMetalOpenGLRenderer`), immediate-mode dispatch has a memory corruption bug that segfaults the JVM within seconds of entering a world.

The fix is to force VBO rendering, which uses a totally different GL code path inside Minecraft. The launcher writes `useVbo:true` into `~/Library/Application Support/Implicite/minecraft/options.txt` before every launch — preserving any existing `options.txt` content. This setting is normally a per-user toggle inside Minecraft Settings → Video; the launcher just guarantees it's on by default for Apple Silicon. See [`ensureVboOptionForMacArm64`](src/launcher.js#L309-L323).

---

## Mod whitelisting

The launcher pulls a `mods.json` manifest from a CDN (`https://cdn.happylab.hu/implicite/mods/mods.json`). Each entry has `filename`, `url`, `size`, and `sha256`.

On every launch:

1. The mods directory is scanned; any JAR **not** listed in the manifest is deleted. Users cannot side-load mods.
2. Each manifest entry is validated: if the file exists, its size and SHA-256 must match. Mismatches are deleted and re-downloaded.
3. Missing files are downloaded with a worker-pool of 8. A fallback URL (manifest directory + filename) is tried if the primary URL 404s.
4. After download, SHA-256 is verified again; mismatched files are deleted and the launch aborts.

This is strict by design: the launcher is the only path mods can reach the game directory.

---

## Settings and data layout

All state lives under macOS's standard Application Support location:

```
~/Library/Application Support/Implicite/
├── config.json          # username, ram (1–16, default 4), keepLauncherOpen
├── debug.log            # launcher INFO/WARN/ERROR
├── game.log             # last MC stdout/stderr
├── java/                # Zulu JRE
├── cache/
│   ├── forge/           # downloaded Forge installer JARs
│   └── lwjgl-patch/     # temp dir for the setResizable bytecode patch
└── minecraft/
    ├── saves/  mods/  resourcepacks/  screenshots/  logs/  options.txt
    ├── versions/1.8.9/1.8.9.{json,jar}
    ├── libraries/<maven-tree>/...
    ├── assets/{indexes,objects}/...
    └── natives/1.8.9/   # extracted natives + (arm64) Tanmay .dylibs
```

`config.json` is a plain JSON object read with `fs.readFileSync` + `JSON.parse`. No `electron-store` or other dependency.

---

## Security posture

- `contextIsolation: true`, `nodeIntegration: false` — the renderer cannot reach Node.
- `app.requestSingleInstanceLock()` — second launches focus the first window instead of running twice.
- DevTools blocked at runtime; zoom/keyboard shortcuts intercepted.
- CSP in the renderer HTML restricts `default-src` to `'self'`.
- All downloads use the system `https` module with a fixed `User-Agent: Implicite-Launcher/1.0` and a manually-implemented redirect chain (max 8 hops).
- Downloads write to a `.tmp` file first and `renameSync` on completion, so a killed launcher never leaves a half-finished JAR that would later be treated as valid.
- Force-kill uses `process.kill(-pid, 'SIGKILL')` so the entire process group dies, including JVM native threads spawned by LWJGL.

---

## Build & run

```
npm install
npm start              # launch Electron in dev
npm run build          # electron-builder, produces a .dmg (macOS) or NSIS installer (Windows)
```

Runtime requirements: macOS (Intel or Apple Silicon) or Windows 10 / 11. The launcher will download Java 8 (Zulu) on first run; no system Java install is needed.

**Windows** is fully supported and currently the most stable target: the game launches without issue, vanilla LWJGL natives are extracted the normal way (none of the Apple Silicon LWJGL/dylib gymnastics apply), and the auto-updater is wired up end-to-end via `electron-updater`.

**macOS** is where the project started and where most of the engineering effort went — the Apple Silicon LWJGL swap, the `setResizable` bytecode patch, and the `useVbo` quirk are all macOS-only code paths. macOS builds are unsigned today, which means the auto-updater is disabled there until a Developer ID certificate (`.cer`) and notarization are added to the build pipeline.
