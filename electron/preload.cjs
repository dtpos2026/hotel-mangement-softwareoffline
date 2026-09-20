/**
 * The bridge between the page and the main process.
 *
 * Everything the renderer can reach is listed here. There is no `require`, no
 * `fs` and no `ipcRenderer` exposed — only these named calls, each of which is
 * handled and validated on the other side.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostApi', {
  /** Present only in the desktop build; the web build checks for it. */
  isDesktop: true,

  app: {
    info: () => ipcRenderer.invoke('app:info'),
    relaunch: () => ipcRenderer.invoke('app:relaunch')
  },

  licence: {
    status: () => ipcRenderer.invoke('licence:status'),
    activate: (key) => ipcRenderer.invoke('licence:activate', String(key || '')),
    deactivate: () => ipcRenderer.invoke('licence:deactivate'),
    machineCode: () => ipcRenderer.invoke('licence:machineCode')
  },

  print: {
    printers: () => ipcRenderer.invoke('print:printers'),
    document: (opts) => ipcRenderer.invoke('print:document', {
      html: String(opts && opts.html || ''),
      printerName: opts && opts.printerName ? String(opts.printerName) : '',
      silent: !!(opts && opts.silent),
      copies: opts && opts.copies,
      widthMm: opts && opts.widthMm,
      heightMm: opts && opts.heightMm,
      pageSize: opts && opts.pageSize,
      landscape: !!(opts && opts.landscape)
    })
  },

  file: {
    save: (opts) => ipcRenderer.invoke('file:save', opts),
    open: (opts) => ipcRenderer.invoke('file:open', opts),
    autoBackup: (opts) => ipcRenderer.invoke('file:autoBackup', opts),
    revealBackups: () => ipcRenderer.invoke('file:revealBackups')
  },

  /** Native menu items route here; returns an unsubscribe function. */
  onMenu: (handler) => {
    const listener = (_event, action) => {
      try { handler(String(action)); } catch (err) { console.error('[menu]', err); }
    };
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  }
});
