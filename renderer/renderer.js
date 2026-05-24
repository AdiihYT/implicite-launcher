// ---------- Platform class on <body> (CSS használja platform-conditional layout-hoz) ----------
document.body.classList.add(`platform-${window.launcher.platform}`);

// ---------- Window controls (frameless platformokon — Win/Linux) ----------
if (window.launcher.platform !== 'darwin') {
  const winMin = document.getElementById('win-minimize');
  const winClose = document.getElementById('win-close');
  if (winMin) winMin.addEventListener('click', () => window.launcher.windowMinimize());
  if (winClose) winClose.addEventListener('click', () => window.launcher.windowClose());
}

// ---------- DOM refs ----------
const screenLogin = document.getElementById('screen-login');
const screenMain  = document.getElementById('screen-main');

const loginForm    = document.getElementById('login-form');
const loginInput   = document.getElementById('login-username');
const loginError   = document.getElementById('login-error');
const loginSubmit  = document.getElementById('login-submit');

const userNameEl   = document.getElementById('user-name');
const logoutBtn    = document.getElementById('logout-btn');

const launchBtn    = document.getElementById('launch-btn');
const statusText   = document.getElementById('status-text');
const statusPct    = document.getElementById('status-pct');
const progressFill = document.getElementById('progress-fill');

const ramSlider    = document.getElementById('ram-slider');
const ramValue     = document.getElementById('ram-value');
const keepOpenTgl  = document.getElementById('keepopen-toggle');
const openLogBtn   = document.getElementById('open-log-btn');
const openDirBtn   = document.getElementById('open-dir-btn');

const resWidthInput    = document.getElementById('res-width');
const resHeightInput   = document.getElementById('res-height');
const resResetBtn      = document.getElementById('resolution-reset');
const resPresetBtn     = document.getElementById('resolution-preset-btn');
const resPresetMenu    = document.getElementById('resolution-preset-menu');
const resVisualiseBtn  = document.getElementById('resolution-visualise');
const fullscreenTgl    = document.getElementById('fullscreen-toggle');
const aspectLockTgl    = document.getElementById('aspect-lock-toggle');

const currentVersionEl   = document.getElementById('current-version');
const updateStatusText   = document.getElementById('update-status-text');
const updateProgressRow  = document.getElementById('update-progress-row');
const updateProgressFill = document.getElementById('update-progress-fill');
const updateRestartBtn   = document.getElementById('update-restart-btn');

// ---------- State ----------
let currentSettings = null;
let launchPhase = 'idle'; // 'idle' | 'launching' | 'running'

// ---------- Username validation ----------
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function validateUsername(name) {
  if (!name || !name.trim()) return 'A felhasználónév kötelező.';
  const v = name.trim();
  if (v.length < 3)  return 'Legalább 3 karakter szükséges.';
  if (v.length > 16) return 'Maximum 16 karakter lehet.';
  if (!USERNAME_RE.test(v)) return 'Csak betű, szám és _ engedélyezett.';
  return null;
}

// ---------- Screen switch ----------
function showScreen(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
  if (name === 'login') screenLogin.classList.add('active');
  else screenMain.classList.add('active');
}

function showTab(name) {
  for (const el of document.querySelectorAll('.tab')) {
    el.classList.toggle('active', el.dataset.tab === name);
  }
  for (const el of document.querySelectorAll('.tab-panel')) {
    el.classList.toggle('active', el.dataset.panel === name);
  }
}

// ---------- Settings ----------
// Vanilla MC default — egyezzen a launcher.js-beli DEFAULT_RESOLUTION-nel.
const DEFAULT_RES = { width: 854, height: 480 };
const RES_LIMITS = { wMin: 320, wMax: 7680, hMin: 240, hMax: 4320 };

async function loadSettings() {
  currentSettings = await window.launcher.getSettings();
  const maxRam = typeof currentSettings.maxRam === 'number' && currentSettings.maxRam >= 1
    ? currentSettings.maxRam
    : 16;
  ramSlider.max = String(maxRam);
  ramSlider.value = String(Math.min(currentSettings.ram, maxRam));
  ramValue.textContent = `${ramSlider.value} GB`;
  keepOpenTgl.checked = !!currentSettings.keepLauncherOpen;
  if (currentSettings.username) userNameEl.textContent = currentSettings.username;

  // Felbontás panel — programatikusan állítjuk, aspect-lock listener-t blokkoljuk.
  const res = currentSettings.resolution || DEFAULT_RES;
  setResolutionInputs(res.width, res.height);
  fullscreenTgl.checked = !!currentSettings.fullscreen;
  aspectLockTgl.checked = !!currentSettings.lockAspectRatio;
}

async function saveCurrentSettings() {
  const payload = {
    username:         currentSettings.username,
    ram:              parseInt(ramSlider.value, 10),
    keepLauncherOpen: keepOpenTgl.checked,
    resolution:       readResolutionInputs(),
    fullscreen:       fullscreenTgl.checked,
    lockAspectRatio:  aspectLockTgl.checked,
  };
  await window.launcher.saveSettings(payload);
  Object.assign(currentSettings, {
    ram: payload.ram,
    keepLauncherOpen: payload.keepLauncherOpen,
    resolution: payload.resolution,
    fullscreen: payload.fullscreen,
    lockAspectRatio: payload.lockAspectRatio,
  });
}

// ---------- Resolution helpers ----------
let suppressAspectSync = false;

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function setResolutionInputs(w, h) {
  suppressAspectSync = true;
  resWidthInput.value  = String(clampInt(w, RES_LIMITS.wMin, RES_LIMITS.wMax, DEFAULT_RES.width));
  resHeightInput.value = String(clampInt(h, RES_LIMITS.hMin, RES_LIMITS.hMax, DEFAULT_RES.height));
  suppressAspectSync = false;
}

function readResolutionInputs() {
  return {
    width:  clampInt(resWidthInput.value,  RES_LIMITS.wMin, RES_LIMITS.wMax, DEFAULT_RES.width),
    height: clampInt(resHeightInput.value, RES_LIMITS.hMin, RES_LIMITS.hMax, DEFAULT_RES.height),
  };
}

const RES_PRESETS = [
  { label: 'Minecraft alap',  width: 854,  height: 480  },
  { label: 'HD 720p',         width: 1280, height: 720  },
  { label: 'HD+ 900p',        width: 1600, height: 900  },
  { label: 'Full HD 1080p',   width: 1920, height: 1080 },
  { label: 'QHD 1440p',       width: 2560, height: 1440 },
  { label: 'UHD 4K',          width: 3840, height: 2160 },
];

async function openPresetMenu() {
  resPresetMenu.innerHTML = '';

  // "Képernyő natív" — a primary display fizikai felbontása.
  let nativeEntry = null;
  try {
    const info = await window.launcher.getDisplayInfo();
    if (info?.width && info?.height) {
      nativeEntry = { label: 'Képernyő natív', width: info.width, height: info.height };
    }
  } catch {}

  const items = nativeEntry ? [nativeEntry, ...RES_PRESETS] : [...RES_PRESETS];
  for (const p of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-item';
    btn.innerHTML = `<span>${p.label}</span><span class="preset-dim">${p.width} × ${p.height}</span>`;
    btn.addEventListener('click', () => {
      setResolutionInputs(p.width, p.height);
      closePresetMenu();
      saveCurrentSettings();
    });
    resPresetMenu.appendChild(btn);
  }
  resPresetMenu.hidden = false;
}

function closePresetMenu() {
  resPresetMenu.hidden = true;
}

function applyAspectLock(changedSide) {
  if (suppressAspectSync) return;
  if (!aspectLockTgl.checked) return;
  // A rögzítendő arány: a NEM most módosított oldal alapján számoljuk vissza,
  // hogy a felhasználó által épp gépelt számot ne írjuk felül.
  const ref = currentSettings?.resolution || DEFAULT_RES;
  const ratio = ref.width / ref.height;
  suppressAspectSync = true;
  if (changedSide === 'width') {
    const w = clampInt(resWidthInput.value, RES_LIMITS.wMin, RES_LIMITS.wMax, DEFAULT_RES.width);
    const h = clampInt(Math.round(w / ratio), RES_LIMITS.hMin, RES_LIMITS.hMax, DEFAULT_RES.height);
    resHeightInput.value = String(h);
  } else {
    const h = clampInt(resHeightInput.value, RES_LIMITS.hMin, RES_LIMITS.hMax, DEFAULT_RES.height);
    const w = clampInt(Math.round(h * ratio), RES_LIMITS.wMin, RES_LIMITS.wMax, DEFAULT_RES.width);
    resWidthInput.value = String(w);
  }
  suppressAspectSync = false;
}

// ---------- Launch state ----------
function setPhase(phase) {
  launchPhase = phase;
  if (phase === 'idle') {
    launchBtn.disabled = false;
    launchBtn.textContent = 'START';
    launchBtn.classList.remove('stop');
    statusText.textContent = 'Készen áll az indításra';
    statusPct.textContent = '';
    progressFill.style.width = '0%';
  } else if (phase === 'launching') {
    launchBtn.disabled = true;
    launchBtn.textContent = 'INDÍTÁS...';
    launchBtn.classList.remove('stop');
  } else if (phase === 'running') {
    launchBtn.disabled = false;
    launchBtn.textContent = 'STOP';
    launchBtn.classList.add('stop');
    statusText.textContent = 'Minecraft fut';
    statusPct.textContent = '';
    progressFill.style.width = '100%';
  }
}

function setStatus(message) {
  statusText.textContent = message;
}

function setProgress(label, value) {
  const pct = Math.max(0, Math.min(1, value || 0));
  if (label) statusText.textContent = label;
  statusPct.textContent = `${Math.round(pct * 100)}%`;
  progressFill.style.width = `${pct * 100}%`;
}

// ---------- Wire up progress events ----------
window.launcher.onProgress((data) => {
  if (!data) return;
  if (data.type === 'status' && data.message) setStatus(data.message);
  else if (data.type === 'progress') setProgress(data.label, data.value);
});

window.launcher.onGameStatus((data) => {
  if (data?.running) setPhase('running');
  else setPhase('idle');
});

// ---------- Auto-updater (Settings → Frissítések szekció) ----------
function setUpdateStatusTone(tone) {
  updateStatusText.classList.remove('is-active', 'is-error');
  if (tone) updateStatusText.classList.add(tone);
}

function renderUpdateStatus(status) {
  // Alap: minden el van rejtve, idle szöveg
  updateProgressRow.hidden = true;
  updateRestartBtn.hidden = true;
  updateRestartBtn.classList.remove('error-mode');
  updateRestartBtn.disabled = false;

  if (!status || status.state === 'idle') {
    updateStatusText.textContent = 'Naprakész';
    setUpdateStatusTone(null);
    return;
  }

  if (status.state === 'checking') {
    updateStatusText.textContent = 'Frissítés ellenőrzése...';
    setUpdateStatusTone('is-active');
    return;
  }

  if (status.state === 'downloading') {
    const pct = Math.round((status.progress || 0) * 100);
    updateStatusText.textContent = status.version
      ? `v${status.version} letöltése · ${pct}%`
      : `Letöltés · ${pct}%`;
    setUpdateStatusTone('is-active');
    updateProgressRow.hidden = false;
    updateProgressFill.style.width = `${pct}%`;
    return;
  }

  if (status.state === 'ready') {
    updateStatusText.textContent = status.version
      ? `v${status.version} készen áll — a következő indításnál aktiválódik`
      : 'Frissítés készen áll — a következő indításnál aktiválódik';
    setUpdateStatusTone('is-active');
    updateRestartBtn.hidden = false;
    updateRestartBtn.textContent = 'Újraindítás most';
    updateRestartBtn.onclick = async () => {
      updateRestartBtn.disabled = true;
      await window.launcher.installUpdate();
    };
    return;
  }

  if (status.state === 'error') {
    updateStatusText.textContent = 'Auto-frissítés sikertelen';
    setUpdateStatusTone('is-error');
    updateRestartBtn.hidden = false;
    updateRestartBtn.classList.add('error-mode');
    updateRestartBtn.textContent = 'Letöltés kézzel';
    updateRestartBtn.onclick = () => window.launcher.openManualUpdate();
  }
}

window.launcher.onUpdateStatus(renderUpdateStatus);
(async () => {
  const [version, initial] = await Promise.all([
    window.launcher.getAppVersion(),
    window.launcher.getUpdateStatus(),
  ]);
  if (version) currentVersionEl.textContent = `v${version}`;
  renderUpdateStatus(initial);
})();

// ---------- Login flow ----------
loginInput.addEventListener('input', () => {
  loginError.textContent = '';
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = loginInput.value.trim();
  const err = validateUsername(value);
  if (err) {
    loginError.textContent = err;
    return;
  }

  loginSubmit.disabled = true;
  currentSettings.username = value;
  await window.launcher.saveSettings({
    ...currentSettings,
    username: value,
  });
  userNameEl.textContent = value;
  loginSubmit.disabled = false;
  loginInput.value = '';
  loginError.textContent = '';
  showScreen('main');
});

logoutBtn.addEventListener('click', async () => {
  if (launchPhase !== 'idle') return;
  currentSettings.username = null;
  await window.launcher.saveSettings({ ...currentSettings, username: null });
  userNameEl.textContent = '—';
  showScreen('login');
  setTimeout(() => loginInput.focus(), 50);
});

// ---------- Tabs ----------
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}

// ---------- Launch button ----------
launchBtn.addEventListener('click', async () => {
  if (launchPhase === 'idle') {
    setPhase('launching');
    setStatus('Indítás előkészítése...');
    const result = await window.launcher.launch(currentSettings.username);
    if (!result?.success) {
      setStatus(result?.error || 'Indítás sikertelen.');
      setPhase('idle');
    }
    // sikeres indítás esetén a game-status event vált át 'running'-ra
  } else if (launchPhase === 'running') {
    launchBtn.disabled = true;
    await window.launcher.forceKill();
  }
});

// ---------- Settings controls ----------
ramSlider.addEventListener('input', () => {
  ramValue.textContent = `${ramSlider.value} GB`;
});
ramSlider.addEventListener('change', saveCurrentSettings);
keepOpenTgl.addEventListener('change', saveCurrentSettings);

openLogBtn.addEventListener('click', () => window.launcher.openDebugLog());
openDirBtn.addEventListener('click', () => window.launcher.openAppDir());

// ---------- Resolution controls ----------
resWidthInput.addEventListener('input', () => applyAspectLock('width'));
resHeightInput.addEventListener('input', () => applyAspectLock('height'));
// Mentés blur/change-re, hogy a gépelés közbeni minden köztes érték ne flusholjon a diszkre.
resWidthInput.addEventListener('change', saveCurrentSettings);
resHeightInput.addEventListener('change', saveCurrentSettings);

resResetBtn.addEventListener('click', () => {
  setResolutionInputs(DEFAULT_RES.width, DEFAULT_RES.height);
  saveCurrentSettings();
});

fullscreenTgl.addEventListener('change', saveCurrentSettings);
aspectLockTgl.addEventListener('change', () => {
  // Aspect-lock bekapcsolásakor a JELENLEGI érték adja a referencia-arányt —
  // ezt a currentSettings.resolution-be is beírjuk, hogy az applyAspectLock
  // ne egy elavult arányból számoljon.
  if (aspectLockTgl.checked) {
    currentSettings.resolution = readResolutionInputs();
  }
  saveCurrentSettings();
});

resPresetBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (resPresetMenu.hidden) openPresetMenu();
  else closePresetMenu();
});
document.addEventListener('click', (e) => {
  if (resPresetMenu.hidden) return;
  if (e.target === resPresetBtn || resPresetBtn.contains(e.target)) return;
  if (resPresetMenu.contains(e.target)) return;
  closePresetMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !resPresetMenu.hidden) closePresetMenu();
});

resVisualiseBtn.addEventListener('click', async () => {
  const size = readResolutionInputs();
  resVisualiseBtn.disabled = true;
  try {
    await window.launcher.visualizeResolution(size);
  } finally {
    setTimeout(() => { resVisualiseBtn.disabled = false; }, 2500);
  }
});

// ---------- Boot ----------
(async function init() {
  await loadSettings();
  const running = await window.launcher.gameIsRunning();
  if (currentSettings.username) {
    showScreen('main');
    if (running) setPhase('running');
    else setPhase('idle');
  } else {
    showScreen('login');
    setTimeout(() => loginInput.focus(), 80);
  }
})();
