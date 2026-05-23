const fs = require('fs');
const path = require('path');
const os = require('os');

function computeAppDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Implicite');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Implicite',
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'implicite',
  );
}

const APP_DIR = computeAppDir();
const LOG_FILE = path.join(APP_DIR, 'debug.log');

function ensureDir() {
  fs.mkdirSync(APP_DIR, { recursive: true });
}

function ts() {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function write(level, message) {
  try {
    ensureDir();
    fs.appendFileSync(LOG_FILE, `[${ts()}] [${level}] ${message}\n`);
  } catch {}
}

function clear() {
  try {
    ensureDir();
    const header = `Implicite Launcher – debug.log – ${new Date().toISOString()}\n` + '-'.repeat(60) + '\n';
    fs.writeFileSync(LOG_FILE, header);
  } catch {}
}

module.exports = {
  APP_DIR,
  LOG_FILE,
  clear,
  info:  (m) => write('INFO',  m),
  warn:  (m) => write('WARN',  m),
  error: (m) => write('ERROR', m),
  debug: (m) => write('DEBUG', m),
};
