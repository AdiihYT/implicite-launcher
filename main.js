const { app, BrowserWindow, ipcMain, Menu, shell, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('./src/logger');

let mainWindow = null;
let mcProcess = null;
let launcher = null;

// Auto-updater state — csak packaged build-ben aktív (dev-ben `app.isPackaged`
// false, ott electron-updater nem fut le).
let autoUpdater = null;
let latestUpdateState = { state: 'idle' };

function bringToFront() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin' && app.dock) app.dock.show();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function blockShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    const mod = input.control || input.meta;
    const key = (input.key || '').toLowerCase();

    if (mod && (key === '=' || key === '+' || key === '-' || key === '0')) {
      event.preventDefault();
      return;
    }
    if (key === 'f12' || (mod && input.shift && key === 'i')) {
      event.preventDefault();
      return;
    }
    if (mod && input.shift && key === 'c') {
      event.preventDefault();
      return;
    }
  });

  win.webContents.on('devtools-opened', () => {
    win.webContents.closeDevTools();
  });

  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  win.webContents.setZoomFactor(1);
  win.webContents.on('zoom-changed', () => {
    win.webContents.setZoomFactor(1);
  });
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  // Mac: hiddenInset + traffic light pozíció (a renderer .topbar bal-pad-elve).
  // Win/Linux: teljesen frameless, saját min/close gomb a renderer-ben.
  const chrome = isMac
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 12 } }
    : { frame: false };

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 680,
    resizable: false,
    backgroundColor: '#050811',
    ...chrome,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: true,
    },
  });

  blockShortcuts(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function attachMcLifecycle(mc) {
  mcProcess = mc;
  if (mainWindow) mainWindow.webContents.send('game-status', { running: true });

  mc.on('exit', (code, signal) => {
    logger.info(`GAME: kilépett – code=${code}, signal=${signal}`);
    mcProcess = null;
    if (mainWindow) {
      mainWindow.webContents.send('game-status', { running: false });
      if (process.platform === 'darwin' && app.dock) app.dock.show();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  mc.on('error', (err) => {
    logger.error(`GAME: process error – ${err.message}`);
    mcProcess = null;
    if (mainWindow) mainWindow.webContents.send('game-status', { running: false });
  });
}

function sendUpdateStatus(state) {
  latestUpdateState = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', state);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    logger.info('UPDATER: dev mode (nem packaged), kihagyás');
    return;
  }

  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    logger.warn(`UPDATER: electron-updater betöltés hiba – ${e.message}`);
    return;
  }

  autoUpdater.autoDownload = true;
  // A letöltött frissítés automatikusan települ a launcher kilépésekor —
  // a felhasználó következő indításánál már az új verzió jön be.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info:  (m) => logger.info(`UPDATER: ${m}`),
    warn:  (m) => logger.warn(`UPDATER: ${m}`),
    error: (m) => logger.error(`UPDATER: ${m}`),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ state: 'downloading', version: info.version, progress: 0 });
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ state: 'idle' });
  });
  autoUpdater.on('download-progress', (p) => {
    sendUpdateStatus({ state: 'downloading', progress: p.percent / 100 });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({ state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    logger.warn(`UPDATER: error – ${err.message}`);
    // Fallback URL: a felhasználó manuálisan tudja letölteni a legfrissebb DMG-t
    // a GitHub Releases oldalról.
    sendUpdateStatus({
      state: 'error',
      error: err.message,
      manualUrl: 'https://github.com/AdiihYT/implicite-launcher/releases/latest',
    });
  });

  // 3s késleltetéssel indul a check, hogy a UI ne lassuljon az induláskor.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      logger.warn(`UPDATER: checkForUpdates failed – ${e.message}`);
    });
  }, 3000);
}

function registerIpc() {
  ipcMain.handle('get-settings', () => launcher.getSettings());

  ipcMain.handle('save-settings', (_e, settings) => {
    launcher.saveSettings(settings);
    return { success: true };
  });

  ipcMain.handle('game-is-running', () => !!(mcProcess && !mcProcess.killed));

  ipcMain.handle('open-debug-log', () => shell.openPath(logger.LOG_FILE));
  ipcMain.handle('open-app-dir', () => shell.openPath(logger.APP_DIR));

  // Window controls — a frameless platformokon (Win/Linux) a renderer
  // saját min/close gombokat rajzol; ezek hívják ezeket az IPC-ket.
  ipcMain.handle('window-minimize', () => mainWindow?.minimize());
  ipcMain.handle('window-close',    () => mainWindow?.close());

  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-update-status', () => latestUpdateState);
  ipcMain.handle('install-update', () => {
    if (!autoUpdater) return { success: false, error: 'updater inaktív (dev mode)' };
    if (latestUpdateState.state !== 'ready') {
      return { success: false, error: 'nincs telepítésre kész frissítés' };
    }
    logger.info('UPDATER: quitAndInstall hívva');
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { success: true };
  });

  ipcMain.handle('open-manual-update', () => {
    shell.openExternal('https://github.com/AdiihYT/implicite-launcher/releases/latest');
  });

  ipcMain.handle('get-display-info', () => {
    const primary = screen.getPrimaryDisplay();
    return {
      width:  primary.size.width,
      height: primary.size.height,
      scaleFactor: primary.scaleFactor || 1,
    };
  });

  // Átmeneti, átlátszó overlay ablak a megadott felbontással, középre helyezve.
  // ~2.5 másodperc után automatikusan bezáródik. A felhasználó így vizuálisan
  // látja, mekkora terület lesz a játék ablaka az adott felbontáson.
  ipcMain.handle('visualize-resolution', (_e, payload) => {
    const w = Math.max(120, Math.min(7680, parseInt(payload?.width,  10) || 0));
    const h = Math.max(120, Math.min(4320, parseInt(payload?.height, 10) || 0));
    if (!w || !h) return { success: false };

    const primary = screen.getPrimaryDisplay().workArea;
    // Ha a kért méret nagyobb a látható területnél, scale-eljük arányosan, hogy
    // ne lógjon ki — a label továbbra is a kért W×H-t mutatja.
    const scale = Math.min(1, primary.width  / w, primary.height / h);
    const winW = Math.round(w * scale);
    const winH = Math.round(h * scale);

    const overlay = new BrowserWindow({
      width:  winW,
      height: winH,
      x: primary.x + Math.round((primary.width  - winW) / 2),
      y: primary.y + Math.round((primary.height - winH) / 2),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    overlay.setIgnoreMouseEvents(true);

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;height:100%;width:100%;
        font-family:'Bricolage Grotesque',system-ui,-apple-system,sans-serif;
        color:#E8EEF6;background:transparent;overflow:hidden;}
      .frame{position:absolute;inset:0;
        border:3px solid #33BCFF;border-radius:10px;
        background:rgba(5,8,17,0.42);
        box-shadow:0 0 0 1px rgba(0,168,239,0.4) inset, 0 0 48px rgba(0,168,239,0.45);
        animation:fade 2500ms ease-out forwards;}
      .label{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
        font-size:clamp(18px, 8vw, 96px);font-weight:800;letter-spacing:-0.02em;
        text-shadow:0 0 28px rgba(0,168,239,0.6);
        background:linear-gradient(180deg,#33BCFF,#00A8EF);
        -webkit-background-clip:text;background-clip:text;color:transparent;}
      .sub{position:absolute;left:50%;top:calc(50% + 8vw + 6px);transform:translateX(-50%);
        font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;
        letter-spacing:0.08em;text-transform:uppercase;color:#9CAAC2;}
      @keyframes fade{0%{opacity:0}10%{opacity:1}80%{opacity:1}100%{opacity:0}}
    </style></head><body>
      <div class="frame">
        <div class="label">${w} × ${h}</div>
        <div class="sub">Felbontás előnézet</div>
      </div></body></html>`;
    overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    overlay.once('ready-to-show', () => overlay.showInactive());
    setTimeout(() => { if (!overlay.isDestroyed()) overlay.close(); }, 2500);

    return { success: true };
  });

  ipcMain.handle('force-kill', () => {
    if (!mcProcess || mcProcess.killed) return { success: true };
    logger.warn(`GAME: kényszerleállítás – PID=${mcProcess.pid}`);
    if (process.platform === 'win32') {
      // Windows-on nincs process group; taskkill /T levágja a child-okat is.
      try {
        spawn('taskkill', ['/pid', String(mcProcess.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        try { mcProcess.kill('SIGKILL'); } catch {}
      }
    } else {
      // Unix: negatív PID = process group kill (Java natív szálait is leveszi).
      try {
        process.kill(-mcProcess.pid, 'SIGKILL');
      } catch {
        try { mcProcess.kill('SIGKILL'); } catch {}
      }
    }
    return { success: true };
  });

  ipcMain.handle('launch', async (event, username) => {
    if (mcProcess && !mcProcess.killed) {
      return { success: false, error: 'A Minecraft már fut.' };
    }

    const send = (type, payload) => {
      try { event.sender.send('progress', { type, ...payload }); } catch {}
    };

    try {
      logger.info(`LAUNCH: ind. – user=${username}`);
      const settings = launcher.getSettings();
      const updated = { ...settings, username };
      launcher.saveSettings(updated);

      const mc = await launcher.launch({
        username,
        ram: settings.ram || 4,
        resolution: settings.resolution,
        fullscreen: settings.fullscreen,
        onStatus: (message) => send('status', { message }),
        onProgress: (label, value) => send('progress', { label, value }),
      });

      attachMcLifecycle(mc);

      if (!settings.keepLauncherOpen && mainWindow) {
        mainWindow.hide();
        if (process.platform === 'darwin' && app.dock) app.dock.hide();
      }

      return { success: true };
    } catch (err) {
      logger.error(`LAUNCH: hiba – ${err.message}\n${err.stack || ''}`);
      send('status', { message: `Hiba: ${err.message}` });
      return { success: false, error: err.message };
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => bringToFront());

  app.whenReady().then(() => {
    logger.clear();
    logger.info(`APP: indul – platform=${process.platform}, arch=${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}`);

    app.setName('Implicite');
    buildMenu();

    launcher = require('./src/launcher');

    registerIpc();
    createWindow();
    setupAutoUpdater();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (mcProcess && !mcProcess.killed) {
      logger.info('APP: kilépés – futó MC process detached, marad életben');
    }
  });
}
