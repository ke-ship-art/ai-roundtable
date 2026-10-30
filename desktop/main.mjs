import { app, BrowserWindow, dialog, session, shell } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateLegacyData } from './data.mjs';
import { start } from '../server.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const applicationName = 'AI Roundtable';
const smokeTest = process.argv.includes('--desktop-smoke');

app.setName(applicationName);
app.setAppUserModelId('local.airoundtable.desktop');
app.setPath(
  'userData',
  process.env.AI_ROUNDTABLE_USER_DATA_DIR
    ? resolve(process.env.AI_ROUNDTABLE_USER_DATA_DIR)
    : join(app.getPath('appData'), applicationName),
);
mkdirSync(app.getPath('userData'), { recursive: true });

const desktopLogDirectory = process.env.AI_ROUNDTABLE_DATA_DIR
  ? resolve(process.env.AI_ROUNDTABLE_DATA_DIR)
  : app.getPath('userData');
mkdirSync(desktopLogDirectory, { recursive: true });
const desktopLogPath = join(desktopLogDirectory, 'desktop.log');
function log(message) {
  appendFileSync(desktopLogPath, `${new Date().toISOString()} ${message}\n`);
}
log(`bootstrap pid=${process.pid} packaged=${app.isPackaged}`);

let mainWindow;
let workspace;
let allowQuit = false;
let shutdownPromise;

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function legacyCandidates() {
  const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.execPath);
  return [
    process.env.AI_ROUNDTABLE_LEGACY_DATA_DIR,
    join(app.getPath('appData'), 'Pi Workspace', 'data'),
    join(executableDirectory, 'data'),
    join(executableDirectory, '..', 'data'),
    join(executableDirectory, '..', '..', 'data'),
    join(projectRoot, 'data'),
  ];
}

async function gracefulQuit() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try {
      log('shutdown requested');
      await workspace?.close();
      log('workspace closed');
    } catch (error) {
      log(`shutdown error: ${error?.stack || error}`);
      dialog.showErrorBox('AI Roundtable 关闭异常', String(error?.stack || error));
    } finally {
      allowQuit = true;
      app.quit();
    }
  })();
  return shutdownPromise;
}

function protectWindow(target, origin) {
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(origin)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  target.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}

async function createApplication() {
  const configuredData = process.env.AI_ROUNDTABLE_DATA_DIR;
  const dataDirectory = configuredData
    ? resolve(configuredData)
    : join(app.getPath('userData'), 'data');
  const legacyPort = Number(process.env.PORT || 4317);
  const candidates = configuredData
    ? [process.env.AI_ROUNDTABLE_LEGACY_DATA_DIR]
    : legacyCandidates();
  const migratedFrom = await migrateLegacyData(dataDirectory, candidates, { port: legacyPort });
  log(`data directory=${dataDirectory}${migratedFrom ? ` migrated-from=${migratedFrom}` : ''}`);

  workspace = await start({
    port: Number(process.env.AI_ROUNDTABLE_PORT || 0),
    dataDir: dataDirectory,
    exitOnShutdown: false,
  });
  const origin = `http://127.0.0.1:${workspace.port}`;
  log(`workspace listening=${origin}`);

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 930,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0c1018',
    title: applicationName,
    icon: join(projectRoot, 'public', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  protectWindow(mainWindow, origin);
  mainWindow.once('ready-to-show', () => {
    log('window ready');
    mainWindow.show();
    if (smokeTest) setTimeout(() => mainWindow?.close(), 500);
  });
  mainWindow.on('close', event => {
    if (allowQuit) return;
    event.preventDefault();
    mainWindow.hide();
    void gracefulQuit();
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  await mainWindow.loadURL(origin);
}

const hasLock = app.requestSingleInstanceLock();
log(`single-instance-lock=${hasLock}`);
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);
  app.on('before-quit', event => {
    if (allowQuit) return;
    event.preventDefault();
    void gracefulQuit();
  });
  app.on('window-all-closed', () => {
    void gracefulQuit();
  });
  app.whenReady().then(createApplication).catch(error => {
    log(`startup error: ${error?.stack || error}`);
    dialog.showErrorBox('AI Roundtable 启动失败', String(error?.stack || error));
    allowQuit = true;
    app.quit();
  });
}
