# Implicite Launcher — fejlesztői útmutató

Ez a dokumentum a meglévő **MineSide Launcher** (Electron) projekt tanulságai alapján készült útmutató az új **Implicite** launcherhez. Az új launcher ugyanúgy Electronra épül, de:

- **Nincs autentikáció** — csak felhasználónév beírás (offline-jellegű login).
- **Minecraft 1.8.9 + Forge** célverzió, nem 1.21 + Fabric.
- **LWJGL 3 csere** kötelező a macOS crash-ek (különösen ablakméretezésnél) elkerüléséhez.
- **Branding**: név = `Implicite`, fő téma szín = `#00A8EF`, logó egyelőre nincs.

---

## 1. Projektszerkezet (ajánlott)

```
implicite-launcher/
├── package.json                # main: main.js, electron-builder konfig
├── main.js                     # Electron főprocessz: ablak, IPC, single-instance
├── preload.js                  # contextBridge → window.launcher.* API
├── src/
│   ├── launcher.js             # Letöltési pipeline + spawn(java, ...)
│   ├── downloader.js           # fetchJSON / downloadFile / downloadConcurrent
│   ├── logger.js               # Fájl-alapú INFO/WARN/ERROR/DEBUG logger
│   ├── forge.js                # 1.8.9 Forge profil betöltés + libtár megoldás
│   └── lwjgl.js                # LWJGL 2 → LWJGL 3 csere logika (lásd 6. pont)
├── renderer/
│   ├── index.html              # CSP-vel ellátott UI shell
│   ├── style.css               # Tema (#00A8EF accent)
│   └── renderer.js             # UI logika, IPC hívások window.launcher-en át
├── tools/
│   └── generate-manifest.js    # mods.json generátor (sha256, méret, url)
├── assets/
│   └── icon.icns               # macOS app ikon (logó hiányában placeholder)
└── README.md
```

> Megegyezik a MineSide szerkezetével, mert ott bevált. Ne találj ki új layoutot.

---

## 2. Bevált alapelvek a meglévő projektből — VIDD ÁT

A MineSide kódbázis ezeket a mintákat használja, és mindegyiket meg kell tartani az új launcherben is.

### 2.1. Electron biztonság / window hardening
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` — preload-on át megy minden IPC.
- `app.requestSingleInstanceLock()` — két launcher nem futhat párhuzamosan, második indításnál az elsőre fókuszálunk (`second-instance` event).
- DevTools tiltva (`devtools-opened` → `closeDevTools()`), zoom tiltva (`setVisualZoomLevelLimits(1,1)` + `before-input-event` blokkolja a `Ctrl/Cmd +/-/0`, `F12`, `Ctrl+Shift+I` kombinációkat).
- Egyedi `Menu.setApplicationMenu` View menü nélkül — ne legyen "Toggle DevTools" sem.
- `resizable: false`, `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 16, y: 12 }`.
- CSP a renderer HTML-ben: `default-src 'self'` + csak a szükséges távoli forrásokat (fontok, avatar) engedélyezzük.

### 2.2. IPC minta
A preload-ban szigorúan **csak** explicit nevesített csatornákat exponálj `contextBridge.exposeInMainWorld('launcher', { ... })`-rel. A renderer **soha** ne lássa az `ipcRenderer`-t közvetlenül.

Példa csatornák, amik az új launcherben is kellenek:
- `get-settings` / `save-settings`
- `launch(username)` → progress eseményeket küld vissza (`progress`, `game-status`)
- `force-kill` — futó MC kilövése
- `game-is-running`
- `open-debug-log`, `open-app-dir`

Ami **NEM kell** (mert nincs auth): `login`, `logout`.

### 2.3. Settings + adatkönyvtár
- Mindent macOS-en az `~/Library/Application Support/Implicite/` alá tegyél.
  - `config.json` — felhasználói beállítások (ram, keepLauncherOpen, **utoljára használt username**).
  - `java/` — letöltött JRE.
  - `minecraft/` — game directory (`saves/`, `mods/`, `resourcepacks/`, `screenshots/`, `logs/`, `versions/`, `libraries/`, `assets/`, `natives/`).
  - `debug.log` — futás közbeni napló.
- `getConfig` / `saveConfig` triviális `JSON.parse`/`JSON.stringify` `fs.readFileSync`-kal — ne húzz be külső csomagot (electron-store sem kell).

### 2.4. Downloader pattern
- `downloadFile`-nál mindig **átmeneti fájlra** írj (`dest + '.tmp'`) és csak `finish` után `renameSync` → így félbeszakadt letöltés sosem ad sérült fájlt.
- Redirect (3xx) követés kézzel a `Location` headerből.
- `User-Agent`-et mindig állíts (pl. `Implicite-Launcher/1.0`).
- `downloadConcurrent(tasks, n)` worker-pool minta — modoknál n=8, asseteknél n=16.
- Hiba esetén `try/unlink` a tmp fájlra, hogy ne maradjon szemét.

### 2.5. Logger
- Fájl-alapú, append-only, formátum: `[YYYY-MM-DD HH:MM:SS.mmm] [LEVEL] message`.
- Indításkor `logger.clear()` egy fejléccel, hogy minden futás új naplóval kezdődjön.
- **Soha ne** `console.log`-olj a renderben felhasználói adatokat — a fő process loggere a forrás.

### 2.6. UI / launch state-gép
A renderer launch állapota: `idle` → `launching` → `running` → `idle`. Csak ezek között válts.
- `idle`: "START" gomb, üres progress.
- `launching`: gomb disabled, status spinner + százalék.
- `running`: gomb "STOP"-ra vált, klikkre `force-kill`.
- A `game-status` eseményt a main küldi vissza, amikor a Java process `exit`-el → ne polling-olj.

### 2.7. Java process kezelés
- `spawn(java, args, { cwd: MC_DIR, detached: true, stdio: 'ignore' })`. **Ne** `unref()`-elj, mert a main figyeli a process lifecycle-ét.
- `force-kill` esetén `process.kill(-pid, 'SIGKILL')` — a **negatív PID** az egész process group-ot leöli (a Java alatt futó natives szálakat is). Fallback `mcProcess.kill('SIGKILL')`.
- Egyszerre csak egy MC futhat — `mcProcess` változó, `if (mcProcess && !mcProcess.killed)` check minden launch elején.
- `keepLauncherOpen=false` esetén launch után `mainWindow.hide()` + `app.dock.hide()`; exit-kor visszahozni.

### 2.8. Offline UUID
1.8.9-ben is `OfflinePlayer:<username>` SHA-mentes (MD5) név-alapú UUID kell — Java `UUID.nameUUIDFromBytes` kompatibilis. A meglévő `offlineUUID(username)` függvényt **változatlanul** vidd át.

### 2.9. Argument processing
A Mojang version JSON `arguments.jvm` / `arguments.game` mezője string + rule-objektum keverék. A meglévő `processArgs(args, replacements, features)` minta működik 1.8.9-re is, **de** 1.8.9-nek még a régi `minecraftArguments` string formátuma is élő — kezeld mindkettőt (lásd 5.2).

---

## 3. Mit NE vigyél át (mert specifikus volt a régi projektre)

- `src/api.js` és minden, ami `LAUNCHER_APP_SECRET`, JWT, `/auth/login`, `/auth/me`, `/coins/*` — törölve. **Nincs szerver.**
- Avatar lekérés `https://minotar.net/helm/...` — vagy hagyd meg dekorációként (CSP-be engedélyezve), vagy generálj statikus placeholdert (az 1.8.9 offline mode-ban a skin amúgy is alapértelmezett Steve).
- `coins` UI, `transfer`, TOTP, email_verified flag-ek — törölve.
- `1.21.11` + Fabric pipeline — helyébe **1.8.9 + Forge** lép (lásd 5.).
- Fabric loader (`meta.fabricmc.net`) lekérés — törölve.

---

## 4. Branding

```css
:root {
  --accent:        #00A8EF;          /* fő téma szín */
  --accent-bright: #33BCFF;          /* hover/glow */
  --accent-dim:    #006FAA;          /* press/border */
  --bg:            #050811;          /* alap háttér (megmaradhat MineSide-szerű) */
  --text:          #E8EEF6;
}
```

- Az ablak `backgroundColor`-a maradjon sötét (`#050811`-ish), az accent legyen `#00A8EF`.
- Logó hiányában: szöveges wordmark "Implicite" Bricolage Grotesque vagy Outfit fonttal, az accent szín alá glow-val.
- `app.name = 'Implicite'`, `title: 'Implicite Launcher'`, `productName` a `package.json` `build` blokkban: `Implicite Launcher`, `appId: com.implicite.launcher`.

---

## 5. Minecraft 1.8.9 + Forge — pipeline

### 5.1. Forge verzió
Használj **Forge 1.8.9 - 11.15.1.2318** (a "Recommended" build) — ez a legstabilabb 1.8.9 Forge, és minden tutorial / mod erre épül.

Két URL kell:
- **Vanilla 1.8.9 version JSON** — `https://launchermeta.mojang.com/mc/game/version_manifest.json`-ból megkeresed az `id: "1.8.9"` entry-t, lekéred a `url`-jét.
- **Forge installer JAR** — `https://maven.minecraftforge.net/net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9-installer.jar`
  > ⚠️ Figyelem: a `1.8.9` suffix **duplán** szerepel a path-ban és a fájlnévben is! Ez egy Forge-specifikus quirk csak ennél a buildnél — a 2318-as build "1.8.9-11.15.1.2318-1.8.9" teljes Maven verzióval lett kiadva (az utolsó `-1.8.9` az MC-version classifier). A korábbi 1.8.9 buildek (pl. 1902) a sima formátumot használták, de azok nem érhetők el már — **csak a 2318 működik 404 nélkül**.

### 5.2. Forge profil kinyerése
A Forge installer JAR-ban van egy `install_profile.json` (régebbi formátum, **nem** az új installer-formátum mint 1.13+!). Ennek a relevánsa:
- `versionInfo` — egy teljes version JSON, ami merge-elendő a vanilla 1.8.9 JSON-jával.
  - `versionInfo.libraries` — Forge függőségei (sok Maven URL `url:` mezővel a könyvtárakban).
  - `versionInfo.mainClass` — `net.minecraft.launchwrapper.Launch`.
  - `versionInfo.minecraftArguments` — **string** formátum (régi stílus), kb.: `--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties {} --userType ${user_type} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker`.

**Implementáció vázlat:**
1. Töltsd le az installer JAR-t a launcher cache-be (`Application Support/Implicite/cache/forge/`).
2. `yauzl` vagy `node-stream-zip` csomaggal (vagy egyszerűen `unzip -p` a `child_process`-szel) olvasd ki az `install_profile.json` és a universal JAR-t az installer-ből. Az installer-en belül a universal JAR neve: `forge-1.8.9-11.15.1.2318-1.8.9-universal.jar` (a duplikált suffix itt is megjelenik). Az `install_profile.json.install.filePath` mezője megmondja a pontos nevet — abból olvasd ki, ne hardcode-old.
3. A universal JAR-t mentsd a `libraries/net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9.jar` útvonalra — ez kerül a classpath-ba. (A Maven artifact verziója a duplikált `1.8.9-11.15.1.2318-1.8.9` string, az `install_profile.json.install.path` mezőjéből olvasd ki a pontos `group:artifact:version` koordinátát.)
4. A `install_profile.json.versionInfo.libraries`-ből minden Maven artifaktot tölts le; ha van `url:` mező, használd azt baseURL-nek, különben `https://libraries.minecraft.net/`.
5. Vanilla MC kliens JAR (`1.8.9.jar`) ugyanúgy mint MineSide-nál.
6. **Mainclass**: `versionInfo.mainClass` (a `net.minecraft.launchwrapper.Launch`).
7. **Game args**: split-eld a `minecraftArguments` stringet whitespace-en, futtasd át a `replaceAll(str, replacements)`-en — készen vagy. Nincs JSON rules / features kezelés a 1.8.9 game args-ra.
8. **JVM args**: vidd át a vanilla JSON `arguments.jvm` vagy (ha hiányzik 1.8.9-ben — mert hiányzik) **statikusan tedd be** a következőket:
   ```
   -Djava.library.path=${natives_directory}
   -Dminecraft.launcher.brand=Implicite
   -Dminecraft.launcher.version=1.0.0
   -cp ${classpath}
   ```
9. RAM args: `-Xmx${ram}G`, `-Xms${ram > 2 ? '1G' : '512M'}`.

### 5.3. Assets
1.8.9 az `assetIndex.id === "1.8"` indexet használja. A pipeline ugyanaz mint MineSide-nál: index letöltés `versionJson.assetIndex.url`-ről, objects iteráció, hash-prefix mappa (`assets/objects/XX/XX...`).

### 5.4. Natives — itt VÁLT a játék (lásd 6.)
A vanilla 1.8.9 version JSON `libraries[]` része tartalmaz `lwjgl-platform`, `jinput-platform` natives JAR-okat **csak x86 / x86_64 macOS-re** — ezeket **NEM** szabad simán kibontani, mert ezek a régi LWJGL 2 natives, ami crashel modern macOS-en. Helyettük LWJGL 3-as natives megy be — részletek a 6. pontban.

---

## 6. **LWJGL 2 → LWJGL 3 csere** (a launcher legfontosabb feature-e)

### 6.1. A probléma
Az eredeti 1.8.9 az **LWJGL 2.9.4-nightly-20150209** verziót használja. Ennek a macOS natives-je:
- 32-bit / 64-bit Intel only (nincs arm64 / Apple Silicon binary).
- Cocoa-integráció hibás a Mojave (10.14) utáni macOS-eken — ablak resize / fullscreen / zoom közben **gyakran segfault-ol** néhány másodpercen belül.
- Rosetta alatt sem stabil M1/M2/M3-on.

### 6.2. A megoldás
A vanilla LWJGL 2 libeket és natives-t **lecseréljük LWJGL 3-ra**, és bevezetünk egy compatibility shim layer-t, hogy a Minecraft 1.8.9 LWJGL 2 API hívásai (org.lwjgl.opengl.Display, GL11, Mouse, Keyboard) működjenek LWJGL 3 (3.2.3 vagy 3.3.x) alatt.

Két stratégia létezik — **válassz egyet és tartsd**:

**A) `lwjgl2-compat` shim (preferált, mert Prism / MultiMC ezt használja).**
Megelőzött, készen kapható drop-in JAR (pl. a `Goldenstack/lwjgl2-compat` projekt) ami LWJGL 2 API-t LWJGL 3-ra fordít. Workflow:
1. A vanilla version JSON `libraries[]`-éből **távolítsd el** a következő artifaktokat (group:artifact):
   - `org.lwjgl.lwjgl:lwjgl`
   - `org.lwjgl.lwjgl:lwjgl_util`
   - `org.lwjgl.lwjgl:lwjgl-platform` (a natives JAR)
   - `net.java.jinput:jinput`
   - `net.java.jinput:jinput-platform`
   - `net.java.jutils:jutils`
2. Tedd be helyettük a classpath-ba:
   - `lwjgl2-compat-<verzió>.jar` (CDN-ről vagy a launcher-ben bundled)
   - `lwjgl-3.3.3.jar`, `lwjgl-opengl-3.3.3.jar`, `lwjgl-glfw-3.3.3.jar`, `lwjgl-stb-3.3.3.jar`, `lwjgl-openal-3.3.3.jar` (Maven Central: `org.lwjgl:lwjgl:3.3.3`)
   - A natives JAR-ok megfelelő macOS classifier-rel:
     - x86_64 macOS-re: `lwjgl-3.3.3-natives-macos.jar`
     - arm64 macOS-re: `lwjgl-3.3.3-natives-macos-arm64.jar`
     - Minden submodulhoz külön natives JAR (opengl, glfw, stb, openal).
3. A natives JAR-okat ugyanúgy bontsd ki a `natives/1.8.9/` mappába mint MineSide csinálja (`unzip -oq ... -d ... -x "META-INF/*"`).
4. JVM arg-ként add hozzá: `-Dlwjgl.libname=lwjgl` és (ha kell) `-Dorg.lwjgl.util.NoChecks=true`.

**B) Custom shim** — magad írod meg a Display/Mouse/Keyboard wrapper-eket. **Ne** csinálj ilyet — túl sok edge case van, és a community-megoldás jobban karbantartott.

> Implementáció: a `src/lwjgl.js` exportál egy `applyLwjgl3Patch(versionJson)` függvényt, ami visszaad egy **módosított libraries listát**. A `launcher.js` ezt hívja közvetlenül a libtárak letöltése **előtt**.

### 6.3. Java verzió kompatibilitás
- 1.8.9 hivatalosan **Java 8**-at vár. LWJGL 3.3.x szintén megy Java 8-on (Java 8+, target 8 bytecode).
- Töltsd le `Java 8` JRE-t az Adoptium API-ról: `https://api.adoptium.net/v3/assets/latest/8/hotspot?architecture=<arch>&image_type=jre&os=mac&vendor=eclipse`.
- Apple Silicon (arm64): Java 8 Adoptium-ban arm64-re elérhető (Temurin 8u372+).
- **Tárold külön Java 8-at** (`java/jdk8-...`) — ne keverd egy esetleges Java 21-gyel, ha később bővítenél.

### 6.4. JVM flag-ek macOS-en
A `-XstartOnFirstThread` JVM flag-et 1.8.9 + LWJGL 3 alatt **kötelező** macOS-en beadni (a GLFW main thread igénye miatt). Ezt a flag-et helyezd a JVM args legelejére, csak ha `process.platform === 'darwin'`.

```js
if (process.platform === 'darwin') jvmArgs.unshift('-XstartOnFirstThread');
```

### 6.5. Várt eredmény
- Az ablak átméretezés, fullscreen toggle, zoom be/ki **nem crashel**.
- Apple Silicon natívan fut (nem Rosetta).
- A FPS jobb, mert az LWJGL 3 GLFW backendje hatékonyabb mint a régi AWT-based LWJGL 2.

---

## 7. Mods kezelése
- Tartsd meg a MineSide `mods.json` manifest mintáját (`filename`, `url`, `sha256`, `size`).
- A `tools/generate-manifest.js`-t **változatlanul** vidd át.
- A `MODS_MANIFEST_URL`-t cseréld le az új CDN-re (pl. `https://cdn.happylab.hu/implicite/mods/mods.json`), vagy hagyd üresen `null`-ra, ha most még nincs mod-stack.
- A modok 1.8.9 Forge-kompatibilisek kell legyenek (`@Mod` annotációval készült .jar-ok, nem Fabric).
- `ensureMods` workflow: manifest letölt → elavult JAR-ok törölve (manifestben nem szereplő nevek) → hiányzók párhuzamosan letöltve.

---

## 8. Felhasználónév-flow (auth helyett)

Mivel nincs szerver, a "login" UI sokkal egyszerűbb:

1. Indításkor a launcher beolvassa `config.json` `username` mezőjét.
2. Ha van → egyből a main screen, gomb előre kitöltve.
3. Ha nincs → username input, "Folytatás" gomb.
4. Validáció kliensoldalon:
   - 3–16 karakter
   - csak `[A-Za-z0-9_]` (Minecraft username szabály)
   - üres nem lehet
5. Mentés `config.json`-ba minden launchnál (ne kelljen újra beírni).
6. UI-on legyen egy "Felhasználónév módosítása" gomb a settings panelen — kis input + mentés.

**Ne** írj `login`, `logout`, `token` mezőt a settings struktúrába. A `getSettings()` visszatérése:
```js
{
  username: string | null,
  ram: number,             // 1..16, default 4
  keepLauncherOpen: bool,  // default false
}
```

---

## 9. UI ajánlás (kihagyhatatlan elemek)

- **Username képernyő** (login helyett): középre igazított card, accent színű "Folytatás" gomb, "Felhasználónév" input.
- **Main screen** — két tab elég:
  - **Play** — nagy START gomb, status row (spinner + szöveg + százalék), progress bar, futás közben STOP-ra vált.
  - **Settings** — RAM slider (1–16 GB, alapérték 4), "Launcher nyitva marad" toggle, "Felhasználónév módosítása" input, "Debug log megnyitása" és "Játékkönyvtár megnyitása Finderben" gombok.
- Status panel megjelenítendő üzenetei (a `launch.js` `send('status', ...)` hívásaiból):
  - "Java 8 ellenőrzése..."
  - "Java 8 letöltése... X%"
  - "Forge installer letöltése... X%"
  - "LWJGL 3 könyvtárak letöltése..."
  - "Library-k letöltése (N fájl)..."
  - "Native fájlok kicsomagolása..."
  - "Asset index letöltése..."
  - "Assetek letöltése (N fájl)..."
  - "Modok ellenőrzése..." (ha van manifest)
  - "Minecraft indítása..."

---

## 10. package.json váz

```json
{
  "name": "implicite-launcher",
  "version": "1.0.0",
  "description": "Implicite Minecraft Launcher",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder --mac"
  },
  "build": {
    "appId": "com.implicite.launcher",
    "productName": "Implicite Launcher",
    "mac": {
      "category": "public.app-category.games",
      "icon": "assets/icon.icns",
      "target": "dmg",
      "hardenedRuntime": false
    },
    "files": [
      "main.js",
      "preload.js",
      "src/**/*",
      "renderer/**/*",
      "assets/**/*"
    ]
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "electron-builder": "^24.0.0"
  }
}
```

> Maradj **zero-runtime-dependency**-ben (mint MineSide). Ha ZIP olvasásra kell csomag (Forge installer JAR-ból kibontás), az `node-stream-zip` jó választás — csak akkor adj hozzá `dependencies`-t.

---

## 11. Common pitfalls / amit a Claude ne csináljon

- **NE** próbáld 1.8.9-et az új Mojang `arguments.jvm/game` formátummal indítani — az még a régi `minecraftArguments` (string) formátum.
- **NE** felejtsd el a `-XstartOnFirstThread` flaget macOS-en LWJGL 3 alatt — különben első frame-nél abortál a GLFW.
- **NE** keverd a vanilla LWJGL 2 natives-t az LWJGL 3-éval ugyanabban a `natives/` mappában — törölj `rm -rf` szinten újra-kicsomagolás előtt, vagy használj verziózott natives dir-t (`natives/1.8.9-lwjgl3/`).
- **NE** add ki a token/auth IPC csatornákat — törölve van az auth, nem szabad átmenteni a régi `login` handler-t.
- **NE** írj `console.log`-ot prod kódban — `logger.info/debug` megy minden.
- **NE** állíts be `nodeIntegration: true`-t — soha. Még tesztelni sem.
- **NE** használj `app.dock.hide()`-ot, ha `keepLauncherOpen=true`.
- **NE** spawn-old a Java process-t `stdio: 'inherit'`-tel — az Electron main konzolt szennyezi és blokkolhat.
- **Apple Silicon ellenőrzés**: minden natives + Java letöltésnél `process.arch === 'arm64'` ágat **mindig** kezeld, ne csak x64-et.
- **NE** hardcode-olj abszolút útvonalakat (`/Users/...`) — minden út `path.join(os.homedir(), ...)`-ból jöjjön.
- **NE** tekintsd a Forge installer JAR-t a kliensnek — a `forge-...-installer.jar` és a `forge-...-universal.jar` **két különböző** fájl. A classpath-ra a universal megy.

---

## 12. Tesztelési checklist (manuális, mert UI)

Mielőtt kész-nek nyilvánítod:

- [ ] Friss telepítés: `~/Library/Application Support/Implicite/` nem létezik → első indítás végigfut Java 8 + Forge + assets letöltéssel.
- [ ] Cache hit: második indítás már ne töltsön semmit.
- [ ] Felhasználónév validáció: rossz formátum (üres, túl rövid, speciális karakter) helyes hibaüzenetet ad.
- [ ] Játék indítás: a Minecraft elindul, és a launcher elrejt (vagy nyitva marad, beállítás szerint).
- [ ] **macOS resize teszt**: a játékban változtasd az ablakméretet 10x, váltogass fullscreen-be → **nincs crash**. (Ez az LWJGL 3 swap fő validációja.)
- [ ] Apple Silicon: M1/M2 alatt natív `arm64` Java + LWJGL natives töltődnek le (`file ~/Library/Application\ Support/Implicite/java/<jdk>/bin/java` mutatja).
- [ ] STOP gomb: futó MC-t leöli, exit handler visszahozza a launcher ablakot.
- [ ] Force-quit during launch: a launcher kilépése közben hagyott `.tmp` fájl ne maradjon a libraries / mods mappákban.
- [ ] Debug log megnyitható, és tartalmazza a teljes pipeline-t.

---

## 13. Kérdések, amiket kezdés előtt tisztázni kell a felhasználóval

- Marad-e a username az **összes futás között megosztott** (egy account a gépen), vagy lehet több profil?
- Kell-e `mods.json` CDN most azonnal, vagy első körben mod nélkül indítjuk a vanilla 1.8.9 + Forge-ot?
- A logó később jön — addig wordmark elég, vagy generáljunk SVG placeholdert?
- Auto-update szükséges? (Electron-builder `electron-updater`-rel megoldható, de extra komplexitás.)
- Code signing / notarization macOS-en az élesre? (Enélkül a felhasználónak Gatekeeper-megkerülő kattintás kell.)

---

## 14. Összefoglaló (TL;DR)

1. **Másold át** a MineSide szerkezetét és patternjeit (window hardening, IPC, downloader, logger, settings, launch state-gép).
2. **Töröld** az összes auth-cuccot, írd át a login UI-t egy felhasználónév-mezővé.
3. **Cseréld a verziót** 1.21+Fabric helyett 1.8.9+Forge-ra (Forge 11.15.1.2318, Java 8).
4. **Cseréld le az LWJGL 2-t LWJGL 3-ra** lwjgl2-compat shim-mel + `-XstartOnFirstThread`-del macOS-en → ez a launcher legfőbb értéke.
5. **Re-brand**: `Implicite`, accent `#00A8EF`, `com.implicite.launcher` appId.
6. **Tesztelj resize-stressz-szel** macOS-en — ez az új launcher létezésének az indoka.
