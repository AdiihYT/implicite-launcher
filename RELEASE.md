# Release & Auto-Update útmutató

A launcher `electron-updater`-rel auto-frissít **GitHub Releases**-ről. Egy `npm run release` parancs buildel + feltölt mindent a `AdiihYT/implicite-launcher` repó Release-eibe, és a már telepített launcher-ek a következő indításnál maguktól észreveszik.

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
1. `electron-builder` lefut, és elkészíti a `dist/`-ben a `.dmg`, `.zip`, `latest-mac.yml` fájlokat (universal arm64+x64)
2. Felcsatlakozik a GitHub API-ra a `GH_TOKEN`-nel
3. Létrehoz egy új Release-t a repóban `v1.0.4` névvel (a verziószám a `package.json`-ból jön)
4. Feltölti mind a 3 fájlt mint Release Asset
5. Publikálja a release-t (alapból nem draft)

Idő: ~2-5 perc lassú netnél (170 MB feltöltés a GitHub-ra, ami sokkal gyorsabb mint pl. SSH-n keresztül a saját CDN-re).

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

A GitHub Release oldalon a `.dmg` fájl publikus letöltési linket kap, pl.:
```
https://github.com/AdiihYT/implicite-launcher/releases/latest
```

Ezt küldd az új játékosoknak. Ők:
1. Letöltik a `.dmg`-t
2. Átdrag-elik az `Applications/` mappába
3. Első indításnál: jobb klikk → Megnyitás (Gatekeeper warning, egyszeri, mert nincs code signing)
4. Innentől az auto-updater intézi a frissítéseket

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
