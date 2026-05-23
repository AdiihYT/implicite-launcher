const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
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
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 680,
    resizable: false,
    backgroundColor: '#050811',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
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
  autoUpdater.autoInstallOnAppQuit = false;
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

  ipcMain.handle('get-update-status', () => latestUpdateState);
  ipcMain.handle('install-update', () => {
    if (!autoUpdater) return { success: false, error: 'updater inaktív (dev mode)' };
    if (latestUpdateState.state !== 'ready') {
      return { success: false, error: 'nincs telepítésre kész frissítés' };
    }
    logger.info('UPDATER: quitAndInstall hívva');
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { success: true };
  });

  ipcMain.handle('open-manual-update', () => {
    shell.openExternal('https://github.com/AdiihYT/implicite-launcher/releases/latest');
  });

  ipcMain.handle('force-kill', () => {
    if (!mcProcess || mcProcess.killed) return { success: true };
    logger.warn(`GAME: kényszerleállítás (SIGKILL) – PID=${mcProcess.pid}`);
    try {
      process.kill(-mcProcess.pid, 'SIGKILL');
    } catch {
      try { mcProcess.kill('SIGKILL'); } catch {}
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
