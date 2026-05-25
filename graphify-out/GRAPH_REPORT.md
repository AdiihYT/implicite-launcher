# Graph Report - .  (2026-05-25)

## Corpus Check
- Corpus is ~22,711 words - fits in a single context window. You may not need a graph.

## Summary
- 299 nodes · 397 edges · 19 communities (15 shown, 4 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.87)
- Token cost: 88,577 input · 9,841 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Download & Forge Pipeline|Download & Forge Pipeline]]
- [[_COMMUNITY_Renderer UI Controls|Renderer UI Controls]]
- [[_COMMUNITY_First-Run Defaults & CDN|First-Run Defaults & CDN]]
- [[_COMMUNITY_electron-builder Config|electron-builder Config]]
- [[_COMMUNITY_NPM Dependencies|NPM Dependencies]]
- [[_COMMUNITY_HTTP Fetch Internals|HTTP Fetch Internals]]
- [[_COMMUNITY_Main Process Lifecycle|Main Process Lifecycle]]
- [[_COMMUNITY_First-Run Baseline Applier|First-Run Baseline Applier]]
- [[_COMMUNITY_Forge Installer Parsing|Forge Installer Parsing]]
- [[_COMMUNITY_Cross-Platform Logger|Cross-Platform Logger]]
- [[_COMMUNITY_ZIP Helper|ZIP Helper]]
- [[_COMMUNITY_Defaults Generator Tool|Defaults Generator Tool]]
- [[_COMMUNITY_Resolution Settings UI|Resolution Settings UI]]
- [[_COMMUNITY_macOS arm64 LWJGL Patch|macOS arm64 LWJGL Patch]]
- [[_COMMUNITY_Launcher Background Art|Launcher Background Art]]
- [[_COMMUNITY_Claude Code Hooks|Claude Code Hooks]]
- [[_COMMUNITY_Defaults Manifest Schema|Defaults Manifest Schema]]
- [[_COMMUNITY_Preload Context Bridge|Preload Context Bridge]]
- [[_COMMUNITY_Update Status Renderer|Update Status Renderer]]

## God Nodes (most connected - your core abstractions)
1. `launch()` - 16 edges
2. `downloadFile()` - 15 edges
3. `Launch pipeline (Minecraft bootstrap)` - 15 edges
4. `build` - 8 edges
5. `mac` - 8 edges
6. `nsis` - 8 edges
7. `fetchJSON()` - 8 edges
8. `First-run baseline defaults applier` - 8 edges
9. `scripts` - 7 edges
10. `withRetry()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Resolution preview overlay window` --shares_data_with--> `Renderer UI controller`  [INFERRED]
  main.js → renderer/renderer.js
- `First-run baseline defaults applier` --references--> `defaults.json CDN manifest`  [INFERRED]
  src/defaults.js → defaults.json
- `Context-isolated preload bridge` --calls--> `IPC Handler Registry (main process)`  [EXTRACTED]
  preload.js → main.js
- `IPC Handler Registry (main process)` --calls--> `Per-platform file logger`  [EXTRACTED]
  main.js → src/logger.js
- `IPC Handler Registry (main process)` --shares_data_with--> `game-status IPC channel`  [EXTRACTED]
  main.js → preload.js

## Hyperedges (group relationships)
- **macOS arm64 Minecraft 1.8.9 compatibility pipeline** — lwjgl_tanmay, launcher_setresizable_patch, launcher_vbo_fix, no_xstartonfirstthread_rationale, mac_arm64_strategy [EXTRACTED 1.00]
- **Launch progress IPC flow (main->preload->renderer)** — launcher_pipeline, main_ipc_layer, preload_bridge, renderer_ui, ipc_channel_progress [EXTRACTED 1.00]
- **First-run provisioning (defaults + mods + assets)** — defaults_module, launcher_mods_whitelist, launcher_assets, downloader_module, first_run_baseline_concept [INFERRED 0.85]

## Communities (19 total, 4 thin omitted)

### Community 0 - "Download & Forge Pipeline"
Cohesion: 0.06
Nodes (54): downloadConcurrent(), downloadFile(), fetchJSON(), ensureForgeInstaller(), ASSETS_DIR, CACHE_DIR, clampInt(), clampRam() (+46 more)

### Community 1 - "Renderer UI Controls"
Cohesion: 0.04
Nodes (38): aspectLockTgl, currentVersionEl, DEFAULT_RES, err, fullscreenTgl, keepOpenTgl, launchBtn, loginError (+30 more)

### Community 2 - "First-Run Defaults & CDN"
Cohesion: 0.09
Nodes (33): User config.json (APP_DIR), defaults.json CDN manifest, First-run baseline defaults applier, defaults-state.json (applied ids), HTTP downloader with retry/concurrency, Idempotent first-run baseline by id, Forge 1.8.9-11.15.1.2318 installer reader, game-status IPC channel (+25 more)

### Community 3 - "electron-builder Config"
Cohesion: 0.07
Nodes (30): build, appId, files, mac, nsis, productName, publish, win (+22 more)

### Community 4 - "NPM Dependencies"
Cohesion: 0.11
Nodes (17): dependencies, adm-zip, electron-updater, description, devDependencies, electron, electron-builder, main (+9 more)

### Community 5 - "HTTP Fetch Internals"
Cohesion: 0.15
Nodes (10): fetchBuffer(), fs, http, https, isTransientError(), logger, path, sleep() (+2 more)

### Community 6 - "Main Process Lifecycle"
Cohesion: 0.15
Nodes (7): { app, BrowserWindow, ipcMain, Menu, shell, screen }, blockShortcuts(), createWindow(), latestUpdateState, logger, path, { spawn }

### Community 7 - "First-Run Baseline Applier"
Cohesion: 0.22
Nodes (13): applyFileEntry(), applyZipEntry(), crypto, ensureFirstRunDefaults(), { fetchJSON, downloadFile }, fs, logger, path (+5 more)

### Community 8 - "Forge Installer Parsing"
Cohesion: 0.23
Nodes (9): { downloadFile }, fs, logger, mavenCoordToPath(), mavenCoordToUrl(), path, readForgeProfile(), toDownloadTasks() (+1 more)

### Community 9 - "Cross-Platform Logger"
Cohesion: 0.24
Nodes (9): APP_DIR, clear(), ensureDir(), fs, LOG_FILE, os, path, ts() (+1 more)

### Community 10 - "ZIP Helper"
Cohesion: 0.27
Nodes (8): AdmZip, entryMatchesAny(), extractAll(), extractEntry(), fs, path, readEntryBuffer(), readEntryJson()

### Community 11 - "Defaults Generator Tool"
Cohesion: 0.29
Nodes (9): crypto, fs, inferEntry(), main(), parseArgs(), path, printUsageAndExit(), sha256File() (+1 more)

### Community 12 - "Resolution Settings UI"
Cohesion: 0.33
Nodes (6): applyAspectLock(), clampInt(), loadSettings(), readResolutionInputs(), saveCurrentSettings(), setResolutionInputs()

### Community 13 - "macOS arm64 LWJGL Patch"
Cohesion: 0.40
Nodes (4): isMacArm64(), patchVersionForMacArm64(), TANMAY_DYLIBS, TANMAY_JARS

### Community 14 - "Launcher Background Art"
Cohesion: 0.50
Nodes (4): Minecraft Night Forest Background Artwork, Launcher Background Branding Asset, Moonlit Pond and Forest Scene, Steve Character on Stone Block

## Knowledge Gaps
- **151 isolated node(s):** `{ contextBridge, ipcRenderer }`, `version`, `entries`, `{ app, BrowserWindow, ipcMain, Menu, shell, screen }`, `path` (+146 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `build` connect `electron-builder Config` to `NPM Dependencies`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `downloadFile()` connect `Download & Forge Pipeline` to `Forge Installer Parsing`, `HTTP Fetch Internals`, `First-Run Baseline Applier`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **What connects `{ contextBridge, ipcRenderer }`, `version`, `entries` to the rest of the system?**
  _153 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Download & Forge Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.06015037593984962 - nodes in this community are weakly interconnected._
- **Should `Renderer UI Controls` be split into smaller, more focused modules?**
  _Cohesion score 0.0425531914893617 - nodes in this community are weakly interconnected._
- **Should `First-Run Defaults & CDN` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._
- **Should `electron-builder Config` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._