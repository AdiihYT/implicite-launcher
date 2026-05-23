# Release & Auto-Update útmutató

Ez a launcher `electron-updater`-rel auto-frissít a saját CDN-edről (`cdn.happylab.hu`). Egy build = három fájl, amit a CDN-re feltöltesz, és onnantól minden már fent lévő telepítés magától észreveszi és letölti.

---

## 1. Hogyan kerül a játékos gépére az első verzió?

1. Lokálisan buildelsz egy `.dmg`-t (lásd 3. pont).
2. Feltöltöd valahova publikusra (CDN, weboldal). A linket átadod a játékosnak.
3. A játékos letölti, megnyitja a `.dmg`-t, átdrag-eli az `Implicite Launcher.app`-ot az `Applications/` mappába.
4. **Első indításnál Gatekeeper warning lesz** (mert nincs Apple Developer code-signing). A játékosnak ezt egyszer kell csinálnia:
   - Right-click az `Implicite Launcher.app`-on → **Open**
   - A dialógusban: **Open** (második gomb)
   - Innentől a Gatekeeper "whitelistezi" az appot, dupla-kattintásra nyitható
5. Innentől minden további frissítés automatikus.

> **Egyetlen verzió, amit kézzel kell letölteniük: az első.** Utána az autoupdater intézi.

---

## 2. Hogyan élik meg a játékosok a frissítést?

Háttérben, transzparensen:

1. Launcher indulása után 3 másodperccel ellenőrzi a CDN-en a `latest-mac.yml`-t.
2. Ha újabb verzió érhető el, fent egy kis pasztila banner jelenik meg: `Frissítés letöltése v1.0.1 – 42%`.
3. Letöltés végén: `Frissítés készen áll (v1.0.1)` + **[Újraindítás]** gomb.
4. Kattintásra a launcher kilép, az új verziót telepíti, és újraindul.
5. Ha az auto-install valamilyen okból megakad (ritka, általában unsigned-app + macOS biztonsági szabály miatt): `Auto-frissítés sikertelen` + **[Letöltés kézzel]** gomb, ami megnyitja a CDN-es release mappát böngészőben. A játékos onnan tudja az új `.dmg`-t kézzel telepíteni.

---

## 3. Hogyan adsz ki új verziót

### 3.1. Verziószám bumpolása

A `package.json` `version` mezőjét emeld. SemVer:
- **patch** (1.0.0 → 1.0.1): bugfix, kompatibilis változás
- **minor** (1.0.0 → 1.1.0): új feature
- **major** (1.0.0 → 2.0.0): breaking change (a játékos `Application Support/Implicite/` mappáját elromlasztanád)

```bash
# kézi szerkesztés VAGY
npm version patch    # auto bump + git tag
```

### 3.2. Build

A repo gyökerében:

```bash
npm install            # ha még nem fut friss deps-szel
npm run build
```

A build elkészül az alábbi mappába: `dist/`

Tartalom a `dist/` mappában (Universal, arm64+x64 egyben):

```
dist/
├── Implicite Launcher-1.0.1-universal.dmg     ← Új telepítéshez
├── Implicite Launcher-1.0.1-universal-mac.zip ← Auto-updater ezt használja
├── latest-mac.yml                              ← Manifest (sha, version, url-ek)
└── builder-debug.yml / builder-effective-config.yaml   ← Build artifakták (figyelmen kívül)
```

A `latest-mac.yml` egy YAML, ami a verziószámot és a `.zip` SHA512 hash-ét tartalmazza. Az `electron-updater` ezt kéri le a CDN-ről, és ebből tudja meg, kell-e frissíteni.

> **Megj.:** az első buildnél `electron-builder` letölti a universal Electron binárist (~300 MB), de cache-eli — második buildtől gyors lesz.

### 3.3. Feltöltés a CDN-re

Hozz létre (vagy biztosítsd, hogy létezik) ezt a mappát a CDN-en:

```
https://cdn.happylab.hu/implicite/releases/
```

Töltsd fel **pontosan ezt a 3 fájlt** a `dist/`-ből:

| Fájl | Mire való |
|---|---|
| `Implicite Launcher-<verzió>-universal.dmg` | Új telepítéshez |
| `Implicite Launcher-<verzió>-universal-mac.zip` | Auto-updater forrása |
| `latest-mac.yml` | A manifest, amit a launcher poll-oz |

A `.dmg`-t és `.zip`-et a régiek MELLÉ tedd (megőrzés / rollback miatt). A `latest-mac.yml`-t **MINDIG felülírd** — ez a kapcsoló, ami a frissítést kiváltja minden játékosnál.

> **Fontos:** ne nevezd át a fájlokat! A `latest-mac.yml` benne hivatkozza az URL-eket, és ha a fájlnév nem stimmel, az auto-update 404-re fut.

### 3.4. Sikerellenőrzés

1. Indítsd el a lokális launcher-t (NE a `dist/`-ből, hanem a Te telepített verziód).
2. ~3 másodperc múlva fent meg kell jelennie a "Frissítés letöltése..." banner-nek.
3. A `debug.log`-ban (Settings → Debug log): `UPDATER: ...` sorok.
4. Letöltés végén kattints az **Újraindítás** gombra → az új verzió ott kell legyen.

---

## 4. Tipikus hibák és teendők

### "Auto-frissítés sikertelen" üzenet a játékosoknál

Ok: unsigned macOS app + macOS biztonsági szabály. **Nem hiba a kódban.** A fallback link megnyit egy böngészőablakot a CDN-es release mappára, ahonnan a játékos manuálisan letölti az új `.dmg`-t.

Hosszú távú megoldás: Apple Developer Program ($99/év) + code-signing + notarization. Ezt a `build.mac.identity: null` blokkban a `package.json`-ban kell visszaállítani egy valós Developer ID-re.

### Build error: `assets/icon.icns missing`

A `package.json` build configja **nem** hivatkozza, mert még nincs logód. Ha készítesz egyet, tedd `assets/icon.icns` névvel, és a `build.mac` blokkba add vissza az `"icon": "assets/icon.icns"` sort.

### Build error: lassú vagy elakadt

Az első build letölti a universal Electron binárist (~300 MB). Ha rossz a háló: várj, vagy próbáld újra. A cache helye: `~/Library/Caches/electron-builder/`.

### Az auto-updater nem indul el dev módban

Ez szándékos: `app.isPackaged` ellenőrzés. Csak a `.dmg`-vel telepített build-ben fut. Ha mégis tesztelni akarod, ideiglenesen vedd ki az `if (!app.isPackaged) return;` sort a `main.js`-ben.

### "There is no signed app to verify" (electron-updater hiba a logban)

Várható unsigned build-nél. A launcher elkapja, és az "Auto-frissítés sikertelen" + manuális letöltés linket mutatja. Nem fatal.

---

## 5. Mit NE csinálj

- **Ne** módosítsd a `latest-mac.yml`-t kézzel. Mindig a build által generáltat töltsd fel.
- **Ne** töltsd fel a `dist/mac-universal/` mappa többi tartalmát (`Implicite Launcher.app/`, `builder-debug.yml`, stb.) — csak a fenti 3 fájlra van szükség.
- **Ne** verziózd lefelé (1.0.1 → 1.0.0). Az `electron-updater` szigorúan SemVer-t használ, és lefelé nem frissít. Ha rollback kell: emelj egy patch verziót egy korábbi build alapján (1.0.0 → 1.0.0-rollback.1 → vagy 1.0.2 hibajavítással).
- **Ne** változtasd meg az `appId`-t (`com.implicite.launcher`) egy újabb verzióban — az auto-updater másik appként kezelné, és nem frissítené a meglévőt.

---

## 6. Gyors checklist egy release-hez

- [ ] `package.json` `version` bumpolva
- [ ] `npm run build` lefutott hiba nélkül
- [ ] A `dist/` mappában megvan mindhárom fájl (`.dmg`, `.zip`, `latest-mac.yml`)
- [ ] A 3 fájl fel van töltve a `https://cdn.happylab.hu/implicite/releases/`-re
- [ ] Egy meglévő (régi) launcher-rel megnyitva 3s után banner jelenik meg
- [ ] Az **Újraindítás** sikeresen frissít a Te gépeden
