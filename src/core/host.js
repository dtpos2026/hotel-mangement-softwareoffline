/**
 * Host adapter.
 *
 * The same application runs two ways: inside Electron, where it can enumerate
 * printers, print silently, write real files and verify a licence in a process
 * the user cannot step through; and in a plain browser, where it can do none of
 * those things. Every screen talks to this module instead of testing for
 * Electron itself, so there is exactly one place that knows the difference.
 */

const api = (typeof window !== 'undefined' && window.hostApi) ? window.hostApi : null;

export const isDesktop = !!(api && api.isDesktop);

/* ------------------------------------------------------------------ info */

let cachedInfo = null;

export async function appInfo() {
  if (cachedInfo) return cachedInfo;
  if (!isDesktop) {
    cachedInfo = { version: 'web', platform: 'browser', packaged: false, userData: '', documents: '' };
    return cachedInfo;
  }
  try { cachedInfo = await api.app.info(); } catch { cachedInfo = { version: '?', platform: 'unknown' }; }
  return cachedInfo;
}

export async function relaunch() {
  if (isDesktop) return api.app.relaunch();
  window.location.reload();
}

/* --------------------------------------------------------------- licence */

/**
 * In the browser build there is nothing to enforce — page storage is editable,
 * so pretending otherwise would only be theatre. The web build runs unlocked
 * and says so; the desktop build is the licensed product.
 */
export async function licenceStatus() {
  if (!isDesktop) {
    return {
      ok: true, licensed: true, status: 'web', unenforced: true,
      message: 'Browser preview — licensing applies to the installed desktop application.',
      details: null, features: null, limits: null, machineCode: ''
    };
  }
  try { return await api.licence.status(); }
  catch (err) { return { ok: false, status: 'error', licensed: false, message: String(err && err.message || err) }; }
}

export async function activateLicence(key) {
  if (!isDesktop) return { ok: false, message: 'Activation is only available in the installed desktop application.' };
  return api.licence.activate(key);
}

/** Asks the licence server for a fresh answer. Needs internet. */
export async function recheckLicence() {
  if (!isDesktop) return licenceStatus();
  try { return await api.licence.recheck(); }
  catch (err) { return { ok: false, status: 'error', message: String(err && err.message || err) }; }
}

/** Fires when a background re-check changes the licence state. */
export function onLicenceChanged(handler) {
  if (!isDesktop || !api.onLicenceChanged) return () => {};
  return api.onLicenceChanged(handler);
}

export async function deactivateLicence() {
  if (!isDesktop) return { ok: false, message: 'Not available in the browser.' };
  return api.licence.deactivate();
}

export async function machineCode() {
  if (!isDesktop) return '';
  try { return await api.licence.machineCode(); } catch { return ''; }
}

/* -------------------------------------------------------------- printing */

/** Real printer list on the desktop; an empty list in the browser. */
export async function listPrinters() {
  if (!isDesktop) return [];
  try { return await api.print.printers(); } catch { return []; }
}

/**
 * Prints a document.
 *
 * On the desktop this can go straight to a named printer with no dialog, with
 * the page set to a continuous 80mm roll so a thermal driver does not pad the
 * receipt out to A4. In the browser it falls back to the hidden-iframe path.
 */
export async function printDocument(html, opts) {
  const o = opts || {};
  if (isDesktop) {
    const result = await api.print.document({
      html,
      printerName: o.printerName || '',
      silent: !!o.silent,
      copies: o.copies || 1,
      widthMm: o.widthMm || null,
      heightMm: o.heightMm || null,
      pageSize: o.pageSize || null,
      landscape: !!o.landscape
    });
    if (!result.ok) throw new Error(result.message || 'Printing failed.');
    return result;
  }
  const { printDocument: browserPrint } = await import('../print/printer.js');
  return browserPrint(html, o);
}

/* ------------------------------------------------------------------ files */

/**
 * Saves text. The desktop gets a real Save dialog and returns where it landed;
 * the browser falls back to a download.
 */
export async function saveFile(opts) {
  const o = opts || {};
  if (isDesktop) return api.file.save(o);
  const { downloadFile } = await import('./backup.js');
  downloadFile(o.filename || 'file.json', o.content || '', o.mime);
  return { ok: true, path: '', downloaded: true };
}

export async function openFile(opts) {
  if (isDesktop) return api.file.open(opts || {});
  return { ok: false, needsPicker: true };
}

/** Silent daily copy into Documents — the one that survives a reinstall. */
export async function autoBackupToDisk(filename, content) {
  if (!isDesktop) return { ok: false, message: 'Not available in the browser.' };
  try { return await api.file.autoBackup({ filename, content }); }
  catch (err) { return { ok: false, message: String(err && err.message || err) }; }
}

export async function revealBackupFolder() {
  if (!isDesktop) return { ok: false };
  return api.file.revealBackups();
}

/* -------------------------------------------------------------- WhatsApp */

export async function whatsappStatus() {
  if (!isDesktop || !api.whatsapp) {
    return { state: 'unavailable', linked: false, qr: '', me: null,
      lastError: 'WhatsApp is only available in the installed desktop application.',
      usage: { lastHour: 0, lastDay: 0, total: 0, hourlyCap: 0, dailyCap: 0 } };
  }
  return api.whatsapp.status();
}

export async function whatsappConnect() {
  if (!isDesktop || !api.whatsapp) return whatsappStatus();
  return api.whatsapp.connect();
}

export async function whatsappDisconnect() {
  if (!isDesktop || !api.whatsapp) return whatsappStatus();
  return api.whatsapp.disconnect();
}

export async function whatsappUnlink() {
  if (!isDesktop || !api.whatsapp) return whatsappStatus();
  return api.whatsapp.unlink();
}

export async function whatsappSend(phone, text, countryCode) {
  if (!isDesktop || !api.whatsapp) {
    return { ok: false, message: 'WhatsApp sending is only available in the installed desktop application.' };
  }
  return api.whatsapp.send({ phone, text, countryCode });
}

export function onWhatsappStatus(handler) {
  if (!isDesktop || !api.whatsapp || !api.whatsapp.onStatus) return () => {};
  return api.whatsapp.onStatus(handler);
}

/* ------------------------------------------------------------------ menu */

export function onMenu(handler) {
  if (!isDesktop || !api.onMenu) return () => {};
  return api.onMenu(handler);
}

/* -------------------------------------------------------------- features */

/**
 * Feature gating. An unlicensed or web build gets everything; a licensed
 * desktop build gets what the licence lists. Gating is a commercial boundary,
 * not a security one — the real enforcement is that the app refuses to run at
 * all once the trial ends without a valid key.
 */
let currentLicence = null;

export function setLicence(status) { currentLicence = status; }
export function getLicence() { return currentLicence; }

export function hasFeature(key) {
  if (!currentLicence || !Array.isArray(currentLicence.features)) return true;
  return currentLicence.features.indexOf(key) > -1;
}

export function unitLimit() {
  if (!currentLicence || !currentLicence.limits) return 0;
  return Number(currentLicence.limits.maxUnits) || 0;
}

export function userLimit() {
  if (!currentLicence || !currentLicence.limits) return 0;
  return Number(currentLicence.limits.maxUsers) || 0;
}
