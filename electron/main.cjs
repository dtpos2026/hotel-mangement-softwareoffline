/**
 * Electron main process.
 *
 * Two decisions shape this file.
 *
 * 1. The application is served from a privileged `app://` scheme rather than
 *    `file://`. A file:// page is not a secure context, so Chromium refuses it
 *    IndexedDB and `crypto.subtle` — exactly the two things this product needs
 *    most. A registered standard+secure scheme restores both and gives storage
 *    a stable origin that survives updates.
 *
 * 2. The renderer gets no Node access at all: context isolation on, node
 *    integration off, and a narrow preload bridge. Licence verification,
 *    printing and file dialogs all run here.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { LicenceService } = require('./licence-service.cjs');
const { machineCode, machineId } = require('./fingerprint.cjs');

const APP_SCHEME = 'app';
const ROOT = path.join(__dirname, '..');
// DevTools opens only when asked for explicitly. Opening it on every
// unpackaged run means `npm start` always spawns a second window, which is
// noise for anyone running from source and confuses window automation.
const isDev = process.argv.includes('--dev');

let mainWindow = null;
let licence = null;         // LicenceService

/* ------------------------------------------------------------- protocol */

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,           // makes it a secure context: IndexedDB + WebCrypto
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
}]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon'
};

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // Resolve inside ROOT and refuse anything that escapes it.
    const target = path.normalize(path.join(ROOT, rel));
    if (!target.startsWith(ROOT)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return new Response('Not found: ' + rel, { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(target).toString());
    const type = MIME[path.extname(target).toLowerCase()];
    if (type) {
      const headers = new Headers(response.headers);
      headers.set('Content-Type', type);
      return new Response(response.body, { status: 200, headers });
    }
    return response;
  });
}

/* --------------------------------------------------------------- window */

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    if (s && s.width > 600 && s.height > 400) return s;
  } catch { /* first run */ }
  return { width: 1440, height: 900, maximized: true };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getNormalBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify({
      width: bounds.width, height: bounds.height,
      x: bounds.x, y: bounds.y,
      maximized: mainWindow.isMaximized()
    }), 'utf8');
  } catch { /* not worth interrupting a shutdown */ }
}

function createWindow() {
  const state = readWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#F4F6F5',
    title: 'Hotel Register',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,           // the preload needs require() for the bridge
      spellcheck: false
    }
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });

  // Nothing in this product should ever navigate away or open a browser window
  // on its own; anything external goes to the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_SCHEME + '://')) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL(`${APP_SCHEME}://local/index.html`);
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  buildMenu();
}

/* ----------------------------------------------------------------- menu */

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Back up data…', accelerator: 'CmdOrCtrl+B', click: () => send('menu', 'backup') },
        { label: 'Restore from backup…', click: () => send('menu', 'restore') },
        { type: 'separator' },
        { label: 'Print register', accelerator: 'F8', click: () => send('menu', 'register') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: '&Reception',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => send('menu', 'dashboard') },
        { label: 'Check in', accelerator: 'F2', click: () => send('menu', 'checkin') },
        { label: 'Check out', accelerator: 'F4', click: () => send('menu', 'checkout') },
        { label: 'Availability calendar', accelerator: 'F9', click: () => send('menu', 'calendar') },
        { type: 'separator' },
        { label: 'Search', accelerator: 'CmdOrCtrl+K', click: () => send('menu', 'search') }
      ]
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer tools', accelerator: 'F12', click: () => mainWindow && mainWindow.webContents.toggleDevTools() }
      ]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Licence and activation', click: () => send('menu', 'licence') },
        { label: 'Printer test page', click: () => send('menu', 'testprint') },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Hotel Register',
              message: 'Hotel Register — Offline Accommodation Management',
              detail: [
                `Version ${app.getVersion()}`,
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
                '',
                `This computer's code: ${machineCode()}`,
                '',
                'Software by Digital Target.',
                'All data is stored on this computer only.'
              ].join('\n'),
              buttons: ['Close']
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* -------------------------------------------------------------- licence */

async function loadLicence() {
  // The licence model is ESM and shared with the admin panel, so it is
  // imported dynamically rather than required.
  const url = pathToFileURL(path.join(ROOT, 'src', 'core', 'licence-model.js')).toString();
  const model = await import(url);
  licence = new LicenceService(app.getPath('userData'), machineId(), machineCode(), model);

  // A quiet re-check in the background, so a revoked or renewed licence is
  // picked up without anyone having to do anything. Never blocks startup.
  setTimeout(() => {
    licence.recheck(false)
      .then(r => { if (r.changed) send('licence-changed', licence.status()); })
      .catch(() => {});
  }, 8000);
}

function registerIpc() {
  ipcMain.handle('licence:status', () => licence.status());

  ipcMain.handle('licence:activate', async (_e, key) => {
    const result = await licence.activate(String(key || ''));
    return result.ok
      ? { ok: true, message: 'Licence activated.', status: licence.status() }
      : { ok: false, status: result.status, offline: !!result.offline, message: result.message };
  });

  ipcMain.handle('licence:recheck', async () => {
    await licence.recheck(true);
    return licence.status();
  });

  ipcMain.handle('licence:deactivate', () => licence.deactivate());

  ipcMain.handle('licence:machineCode', () => machineCode());

  /* --- printing ---------------------------------------------------------- */

  ipcMain.handle('print:printers', async () => {
    if (!mainWindow) return [];
    try {
      const printers = await mainWindow.webContents.getPrintersAsync();
      return printers.map(p => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: !!p.isDefault,
        status: p.status
      }));
    } catch (err) {
      console.error('[print] could not list printers:', err.message);
      return [];
    }
  });

  /**
   * Prints an HTML document. `widthMm` switches the page to a continuous roll
   * so an 80mm receipt is not padded out to A4 by the driver.
   */
  ipcMain.handle('print:document', async (_e, opts) => {
    const o = opts || {};
    const worker = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false, javascript: false }
    });

    try {
      await worker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(o.html || ''));
      // Give embedded images (the logo) a moment to decode before capture.
      await new Promise(r => setTimeout(r, 220));

      const printOptions = {
        silent: !!o.silent,
        printBackground: true,
        copies: Math.max(1, Math.min(5, Number(o.copies) || 1)),
        margins: { marginType: 'none' }
      };
      if (o.printerName) printOptions.deviceName = o.printerName;
      if (o.widthMm) {
        // Electron takes microns; the height is a generous roll length that a
        // thermal driver truncates at the cut.
        printOptions.pageSize = {
          width: Math.round(Number(o.widthMm) * 1000),
          height: Math.round(Number(o.heightMm || 2000) * 1000)
        };
      } else if (o.pageSize) {
        printOptions.pageSize = o.pageSize;
        printOptions.landscape = !!o.landscape;
      }

      const result = await new Promise(resolve => {
        worker.webContents.print(printOptions, (success, reason) => resolve({ success, reason }));
      });
      return result.success
        ? { ok: true }
        : { ok: false, message: result.reason === 'cancelled' ? 'Printing was cancelled.' : ('Printing failed: ' + result.reason) };
    } catch (err) {
      return { ok: false, message: err.message };
    } finally {
      if (!worker.isDestroyed()) worker.destroy();
    }
  });

  /* --- files ------------------------------------------------------------- */

  ipcMain.handle('file:save', async (_e, opts) => {
    const o = opts || {};
    const result = await dialog.showSaveDialog(mainWindow, {
      title: o.title || 'Save',
      defaultPath: path.join(o.directory || app.getPath('documents'), o.filename || 'file.json'),
      filters: o.filters || [{ name: 'Backup file', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    try {
      fs.writeFileSync(result.filePath, o.content || '', 'utf8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, message: 'Could not write the file: ' + err.message };
    }
  });

  ipcMain.handle('file:open', async (_e, opts) => {
    const o = opts || {};
    const result = await dialog.showOpenDialog(mainWindow, {
      title: o.title || 'Open',
      properties: ['openFile'],
      filters: o.filters || [{ name: 'Backup file', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
    try {
      return { ok: true, path: result.filePaths[0], content: fs.readFileSync(result.filePaths[0], 'utf8') };
    } catch (err) {
      return { ok: false, message: 'Could not read the file: ' + err.message };
    }
  });

  ipcMain.handle('file:revealBackups', () => {
    const dir = path.join(app.getPath('documents'), 'Hotel Register Backups');
    try { fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); return { ok: true, path: dir }; }
    catch (err) { return { ok: false, message: err.message }; }
  });

  /**
   * Silent automatic backup to Documents. The renderer already keeps a copy in
   * browser storage; this one survives a reinstall, which is the copy that
   * actually matters.
   */
  ipcMain.handle('file:autoBackup', (_e, opts) => {
    const o = opts || {};
    try {
      const dir = path.join(app.getPath('documents'), 'Hotel Register Backups');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, o.filename || `backup-${Date.now()}.json`);
      fs.writeFileSync(file, o.content || '', 'utf8');

      // Keep the 30 most recent and delete the rest.
      const kept = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      kept.slice(30).forEach(x => { try { fs.unlinkSync(path.join(dir, x.f)); } catch { /* ignore */ } });

      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    userData: app.getPath('userData'),
    documents: app.getPath('documents'),
    packaged: app.isPackaged
  }));

  ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });
}

/* ------------------------------------------------------------ lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerAppProtocol();
    await loadLicence();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
