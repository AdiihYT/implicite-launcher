# Release & Auto-Update útmutató

A launcher `electron-updater`-rel auto-frissít **GitHub Releases**-ről, **macOS-en és Windows-on egyaránt**. Egy `npm run release` parancs mindkét platformra buildel és feltölt mindent a `AdiihYT/implicite-launcher` repó Release-eibe, és a már telepített launcher-ek (mindkét platformon) a következő indításnál maguktól észreveszik.

## Platformok

| Platform | Telepítő | Auto-update | Code signing |
|---|---|---|---|
| **macOS** (Universal arm64+x64) | `.dmg` | `electron-updater` + Squirrel.Mac (`SQRLDisableCodeSigningVerification`-vel megkerülve) | Nincs (Gatekeeper warning első indításkor) |
| **Windows** (x64, Win 10/11) | NSIS `.exe` installer | `electron-updater` + NSIS | Nincs (SmartScreen warning első indításkor) |

---

## 1. Egyszeri setup: GitHub Personal Access Token

Ez kell ahhoz, hogy az `electron-builder` a Te nevedben tudjon Release-t létrehozni és fájlokat feltölteni a repóba.

### 1.1. Token létrehozása

1. Menj ide: <https://github.com/settings/tokens?type=beta> (fine-grained token, javasolt) **vagy** <https://github.com/settings/tokens> (classic)
2. **Fine-grained (ajánlott)**:
   - **Token name**: pl. `implicite-launcher releases`
   - **Expiration**: 1 év (vagy "No expiration" ha nem zavar)
   - **Repository access**: Only select repositories → válaszd ki: `AdiihYT/implicite-launcher`
   - **Repository permissions** → **Contents**: Read and write
   - **Generate token** → másold ki a `github_pat_xxx` stringet
3. **Classic** (ha a fine-grained UI nem megy):
   - Scope: `repo` (az egész) — vagy ha publik a repo: `public_repo` is elég
   - Generate → másold ki a `ghp_xxx` stringet

### 1.2. Token mentése

A legegyszerűbb: tedd be a shell rc-be (`~/.zshrc`), és nyiss egy új terminált:

```bash
echo 'export GH_TOKEN="github_pat_xxx_itt_a_token"' >> ~/.zshrc
source ~/.zshrc
```

Verifikáld:
```bash
echo $GH_TOKEN     # nem üres
```

> Ha nem akarod a shell rc-be tenni: `GH_TOKEN=xxx npm run release` inline is megy.

---

## 2. Új release kiadása

A teljes folyamat 3 parancs:

```bash
# 1. Verzió bumpolása (kézzel a package.json-ban VAGY npm version)
npm version patch      # 1.0.3 → 1.0.4 (auto bump + git tag létrehozása)
# vagy: npm version minor / npm version major

# 2. Build + publish egy lépésben
npm run release

# 3. Push (a `npm version` által létrehozott tag-et is fel kell tolni)
git push --follow-tags
```

Az `npm run release` lefutása:
1. `electron-builder` lefut **mindkét platformra** (Mac + Windows), és elkészíti a `dist/`-ben:
   - **macOS**: `.dmg`, `.zip` (universal arm64+x64), `latest-mac.yml`
   - **Windows**: `.exe` (NSIS x64 installer), `latest.yml`
2. Felcsatlakozik a GitHub API-ra a `GH_TOKEN`-nel
3. Létrehoz egy új Release-t a repóban `v1.0.X` névvel (a verziószám a `package.json`-ból jön)
4. Feltölti az összes file-t mint Release Asset (Mac + Win egyazon release-ben)
5. Publikálja a release-t (alapból nem draft)

Idő: ~5-10 perc (kb. 170 MB Mac + ~120 MB Win feltöltés).

### Csak az egyik platformra buildelsz?

```bash
npm run release:mac   # csak Mac (.dmg + .zip + latest-mac.yml)
npm run release:win   # csak Windows (.exe + latest.yml)
```

### Build Windows-ra Mac-ről

Az `electron-builder` macOS-en is le tudja gyártani a Windows `.exe`-t (NSIS-szel). **Wine-ra nincs szükség**, mert nem signzünk. Első futáskor `electron-builder` letölti az NSIS belső package-eit (~50 MB, cache-elve).

---

## 3. Mit lát a felhasználó?

A folyamat ugyanaz mint korábban, csak GitHub a forrás:

1. Launcher indulása után 3 másodperccel ellenőrzi a `https://api.github.com/repos/AdiihYT/implicite-launcher/releases/latest`-et
2. Ha újabb verzió érhető el (a `package.json` `version`-nél nagyobb): banner megjelenik `Frissítés letöltése v1.0.4 – 42%`
3. Letöltés végén: `Frissítés készen áll (v1.0.4)` + **[Újraindítás]** gomb
4. Kattintásra: kilép, telepít, újraindul
5. Fallback hibánál: `Auto-frissítés sikertelen` + **[Letöltés kézzel]** gomb → megnyitja a `https://github.com/AdiihYT/implicite-launcher/releases/latest` oldalt

---

## 4. Első telepítés új gépekre

A GitHub Release oldalon mind a Mac (`.dmg`) mind a Windows (`.exe`) fájl publikus letöltési linket kap:
```
https://github.com/AdiihYT/implicite-launcher/releases/latest
```

### macOS

1. Letöltik a `.dmg`-t (`Implicite-Launcher-X.Y.Z-universal.dmg`)
2. Átdrag-elik az `Applications/` mappába
3. Első indításnál: jobb klikk → Megnyitás (Gatekeeper warning, egyszeri, mert nincs code signing)
4. Innentől az auto-updater intézi a frissítéseket

### Windows

1. Letöltik az `.exe`-t (`Implicite-Launcher-X.Y.Z-x64.exe`)
2. Dupla-kattintás → **SmartScreen warning**: "Windows protected your PC" → **More info** link → **Run anyway** gomb (egyszeri, mert nincs code signing)
3. NSIS wizard: telepítési hely választás (alapból `%LOCALAPPDATA%\Programs\Implicite Launcher`) → Install
4. Indítható a Start menüből vagy az asztali shortcut-ról
5. Innentől az auto-updater intézi a frissítéseket (`%APPDATA%\Implicite\` mappába cache-elve)

---

## 5. Draft release (opcionális, ha tesztelni akarsz publikálás előtt)

Ha egy új verziót nem akarsz mindenkinek azonnal kiadni, használhatsz draft release-t:

A `package.json` `build.publish` blokkjában:
```json
"releaseType": "draft"
```

Az `npm run release` lefut, a release létrejön draft-ként a GitHub-on. **Az `electron-updater` draft release-eket nem lát.** Tesztelsz, és amikor készen áll, manuálisan a GitHub repo Releases oldalán megnyomod a "Publish release" gombot — onnantól megy ki minden launcher-nek.

Általában nem szükséges, csak ha nagyobb változás van és komolyabb staging kell.

---

## 6. Migration az 1.0.3-as CDN-buildtől

Az eddig telepített 1.0.3-as kliensek (a Te gépeden lévő) a CDN-en lévő `latest-mac.yml`-t pollozzák, **nem** a GitHub-ot. Egyszeri kézi migráció kell:

1. Vidd ki a következő GitHub release-t (`1.0.4`).
2. Manuálisan töltsd le az `Implicite Launcher-1.0.4-universal.dmg`-t a GitHub Release oldalról.
3. Cseréld a `Applications/Implicite Launcher.app`-ot.
4. Onnantól a saját launcher-ed is GitHub-ról fog frissülni.

(Mivel valószínűleg csak egy gépen van telepítve eddig — a saját Mac-eden —, ez nem nagy ügy. Ha viszont már több játékos telepítette az 1.0.3-at: tartsd a CDN-en a `latest-mac.yml`-t friss `1.0.4` verzióra mutatva még egy round-ig, hogy átmigráljanak.)

---

## 7. Tipikus hibák

### `Error: 401 Bad credentials`
A `GH_TOKEN` nincs beállítva, vagy lejárt, vagy nincs `Contents: write` joga az adott repóra. Hozz létre újat (1.1).

### `Error: Resource not accessible by personal access token`
Fine-grained token van, de a Repository access vagy a Permissions nincs jól. Generálj újat `Contents: Read and write` joggal.

### `Error: Cannot find module 'electron-updater'`
Csak akkor fordulhat elő ha valaki manuálisan nyúlt a `node_modules`-be. `npm install`.

### Windows-on `SmartScreen` warning első indításkor
Várható unsigned build-nél. A felhasználó: **More info → Run anyway**. Egyszeri, a Windows ezután "ismerős" appként kezeli. Hosszú távú megoldás: EV code-signing cert ($300+/év).

### Windows-on auto-update nem indul el
`autoInstallOnAppQuit: true` van beállítva — a frissítés a launcher kilépésekor települ, **következő** indításnál jön az új verzió. Ha a játékos azonnal akarja: a Settings → Frissítések szekcióban az **Újraindítás most** gomb. A NSIS-alapú Windows updater nem igényel külön `SQRLDisable...` flag-et (csak Mac-Squirrel-specifikus).

### A frissítés letöltődik, de `Auto-frissítés sikertelen`
Várható unsigned build-nél olykor. A fallback "Letöltés kézzel" gomb → GitHub release oldal. Hosszú távon: Apple Developer Program.

### Build error: `assets/icon.icns missing`
A `package.json` build configja jelenleg **nem** hivatkozza, mert még nincs logód. Ha készítesz egyet (.icns formátum), tedd `assets/icon.icns` névvel, és a `build.mac` blokkba add hozzá: `"icon": "assets/icon.icns"`.

---

## 8. Quick checklist egy release-hez

- [ ] `GH_TOKEN` környezeti változó beállítva (egyszer kell)
- [ ] `npm version patch` (vagy `minor`/`major`) — bumpolja a verziót + git tag
- [ ] `npm run release` — buildel + felölt GitHub-ra
- [ ] `git push --follow-tags` — a tag is felmegy a GitHub repóba
- [ ] Egy meglévő launcher elindítva ~3 mp után megjelenik a frissítés banner
- [ ] **[Újraindítás]** sikeresen átfrissít az új verzióra

---

## 9. Mit NE csinálj

- **Ne** módosítsd a GitHub Release-be feltöltött fájlokat (`latest-mac.yml`, `.zip`, `.dmg`) kézzel. A `electron-updater` SHA512-t ellenőriz, kézi módosítás hibára futtatja.
- **Ne** szedj le egy Release-t, ha az `electron-updater` már látta. Inkább adj ki egy újabbat (1.0.4 → 1.0.5) javítással.
- **Ne** verziózz lefelé. `electron-updater` szigorú SemVer, lefelé nem frissít.
- **Ne** változtasd meg az `appId`-t (`com.implicite.launcher`) egy újabb verzióban — az auto-updater másik appként kezelné.
