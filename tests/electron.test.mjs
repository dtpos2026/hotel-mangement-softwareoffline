/**
 * Desktop build tests.
 *
 * Launches the real Electron app and checks the things that only exist there:
 * the privileged app:// origin (and the IndexedDB and WebCrypto it unlocks),
 * licence verification in the main process, printer enumeration, the native
 * file bridge, and that the renderer has no access to Node.
 *
 * Run: node tests/electron.test.mjs
 */

import { _electron as electron } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0, suiteName = '';
const failures = [];
const suite = n => { suiteName = n; console.log('\n\x1b[1m' + n + '\x1b[0m'); };
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; failures.push(suiteName + ' › ' + label + (detail ? ' (' + detail + ')' : ''));
    console.log('  \x1b[31m✗ ' + label + '\x1b[0m' + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
};
const eq = (label, actual, expected, detail) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, same, same ? detail : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const userData = mkdtempSync(join(tmpdir(), 'hr-electron-'));

// Playwright may be installed globally, so point it at this project's binary.
const electronBinary = join(process.cwd(), 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

let app = await electron.launch({
  executablePath: existsSync(electronBinary) ? electronBinary : undefined,
  args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
  cwd: process.cwd(),
  env: Object.assign({}, process.env, { ELECTRON_DISABLE_SECURITY_WARNINGS: '1' })
});

/** The app window, not DevTools or a hidden print worker. */
async function appWindow() {
  for (let i = 0; i < 40; i++) {
    const match = app.windows().find(w => w.url().startsWith('app://'));
    if (match) return match;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('The application window never appeared. Open windows: ' +
    app.windows().map(w => w.url()).join(', '));
}

await app.firstWindow();
let page = await appWindow();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
await page.waitForTimeout(3500);

/* ------------------------------------------------------------ the origin */

suite('Privileged app:// origin');

const origin = await page.evaluate(() => ({
  href: location.href,
  protocol: location.protocol,
  secure: window.isSecureContext,
  hasSubtle: !!(window.crypto && window.crypto.subtle),
  hasIndexedDb: typeof indexedDB !== 'undefined'
}));
ok('the app is served from app://', origin.protocol === 'app:', origin.href);
ok('the page is a secure context', origin.secure === true);
ok('WebCrypto is available', origin.hasSubtle === true);
ok('IndexedDB is available', origin.hasIndexedDb === true);

/* --------------------------------------------------------- renderer lockdown */

suite('The renderer has no Node access');
const sandbox = await page.evaluate(() => ({
  require: typeof window.require,
  process: typeof window.process,
  module: typeof window.module,
  ipcRenderer: typeof window.ipcRenderer,
  hostApi: typeof window.hostApi,
  hostKeys: window.hostApi ? Object.keys(window.hostApi).sort() : []
}));
ok('require() is not exposed', sandbox.require === 'undefined');
ok('process is not exposed', sandbox.process === 'undefined');
ok('ipcRenderer is not exposed', sandbox.ipcRenderer === 'undefined');
ok('only the hostApi bridge is exposed', sandbox.hostApi === 'object');
ok('the bridge surface is exactly what is intended',
  sandbox.hostKeys.join(',') === 'app,file,isDesktop,licence,onLicenceChanged,onMenu,print,whatsapp', sandbox.hostKeys.join(','));

/* ------------------------------------------------------------------ boot */

/* --------------------------------------------------------------- licence */

suite('Licence gate');

const fresh = await page.evaluate(() => window.hostApi.licence.status());
eq('a fresh install is not licensed', fresh.licensed, false);
eq('and it says so plainly', fresh.status, 'none');
ok('the activation screen is shown', await page.locator('text=Activate your software').count() > 0);
ok('a machine code is offered', /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(fresh.machineCode), fresh.machineCode);

// Malformed keys are caught locally, with no network involved.
const malformed = await page.evaluate(() => window.hostApi.licence.activate('NOT-A-KEY'));
eq('a malformed key is refused without touching the network', malformed.ok, false);
eq('and it is reported as malformed', malformed.status, 'malformed');
ok('the message shows the expected shape', /HR-/.test(malformed.message), malformed.message);

const short = await page.evaluate(() => window.hostApi.licence.activate('HR-1234'));
eq('a short key is refused', short.ok, false);

// A well-formed key with no internet must say exactly that, not fail silently.
const wellFormed = await page.evaluate(() => window.hostApi.licence.activate('HR-4F2K-9XQP-7M3A'));
eq('a well-formed key gets past the format check', wellFormed.status !== 'malformed', true, wellFormed.status);
if (wellFormed.offline) {
  ok('with no internet the message says so', /internet/i.test(wellFormed.message), wellFormed.message);
  ok('and it explains this is only needed once', /once|after activation/i.test(wellFormed.message));
} else {
  ok('an unknown key is refused by the server', wellFormed.ok === false, wellFormed.message);
}

suite('The licence cache is honoured');

// Write a valid cache the way the app would, then restart and confirm the app
// opens. This is test setup, not a product path: it needs the machine secret.
const { LicenceStore } = await import('../electron/licence-store.cjs');
const { machineId } = await import('../electron/fingerprint.cjs');
const seeded = new LicenceStore(userData, machineId());
seeded.save('HR-TEST-TEST-TEST', {
  key: 'HR-TEST-TEST-TEST', businessName: 'Electron Test Property',
  ownerName: 'Test Owner', phone: '0300-1234567',
  plan: 'professional', issuedAt: new Date().toISOString().slice(0, 10),
  expiresAt: '', maxUnits: 100, maxUsers: 15,
  features: ['reports', 'expenses', 'housekeeping', 'dayClose', 'backupRestore', 'userManagement', 'advancedReports'],
  revoked: false, machineId: machineId()
});
ok('a cache was written for the test', seeded.activated);

await app.close();
const app2 = await electron.launch({
  executablePath: existsSync(electronBinary) ? electronBinary : undefined,
  args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userData}`],
  cwd: process.cwd(),
  env: Object.assign({}, process.env, { ELECTRON_DISABLE_SECURITY_WARNINGS: '1' })
});
await app2.firstWindow();
let page2 = null;
for (let i = 0; i < 40; i++) {
  page2 = app2.windows().find(w => w.url().startsWith('app://'));
  if (page2) break;
  await new Promise(r => setTimeout(r, 250));
}
await page2.waitForTimeout(2500);

const licensed = await page2.evaluate(() => window.hostApi.licence.status());
eq('a cached licence opens the software', licensed.licensed, true);
eq('the business name is read back', licensed.details.businessName, 'Electron Test Property');
eq('the owner name is read back', licensed.details.ownerName, 'Test Owner');
eq('the phone is read back', licensed.details.phone, '0300-1234567');
eq('the plan is read back', licensed.details.plan, 'Professional');
eq('the unit limit is read back', licensed.details.units, '100');
ok('features are read back', Array.isArray(licensed.features) && licensed.features.includes('advancedReports'));
ok('the sign-in screen follows activation', await page2.locator('text=Sign in to continue').count() > 0);
ok('the default credentials are hinted', await page2.locator('text=First time here?').count() > 0);

// Sign in, so the rest of the checks run against the real app.
await page2.fill('[name="username"]', 'admin');
await page2.fill('#password', '123');
await page2.click('#signin');
await page2.waitForTimeout(900);
ok('the default password forces a change', await page2.locator('text=Choose a new password').count() > 0);
const pw = await page2.locator('.card input[type=password]').all();
await pw[0].fill('kalam2026');
await pw[1].fill('kalam2026');
await page2.click('#save');
await page2.waitForTimeout(2200);
ok('the app opens once the password is set', (await page2.evaluate(() => typeof window.__hms)) === 'object');

const removed = await page2.evaluate(() => window.hostApi.licence.deactivate());
eq('a licence can be removed', removed.licensed, false);

// Everything below runs against the second instance.
page = page2;
app = app2;

suite('WhatsApp bridge');
const wa = await page.evaluate(() => window.hostApi.whatsapp.status());
ok('the WhatsApp status is readable', typeof wa.state === 'string', wa.state);
eq('it starts unlinked', wa.linked, false);
ok('sending caps are published', wa.usage && wa.usage.hourlyCap > 0 && wa.usage.dailyCap > 0,
  JSON.stringify(wa.usage));
const waSend = await page.evaluate(() => window.hostApi.whatsapp.send({ phone: '0300-1234567', text: 'hi' }));
eq('sending while unlinked is refused', waSend.ok, false);
ok('and it says how to link', /Settings|scan|QR/i.test(waSend.message), waSend.message);
const waBad = await page.evaluate(() => window.hostApi.whatsapp.send({ phone: 'abc', text: 'hi' }));
eq('a bad number is refused', waBad.ok, false);

/* -------------------------------------------------------------- printing */

suite('Storage on the desktop');
const booted = await page.evaluate(() => ({
  storage: window.__hms ? window.__hms.store.db.storageKind() : null,
  degraded: window.__hms ? window.__hms.store.db.degraded : null
}));
eq('IndexedDB is the storage engine', booted.storage, 'indexeddb');
eq('storage is not in the degraded fallback', booted.degraded, false);

suite('Printing through the desktop bridge');
const printers = await page.evaluate(() => window.hostApi.print.printers());
ok('the printer list can be enumerated', Array.isArray(printers), typeof printers);
console.log(`    \x1b[2m${printers.length} printer(s) visible in this container\x1b[0m`);

// Printing with no printer installed must fail cleanly, not hang or crash.
const printAttempt = await page.evaluate(() => window.hostApi.print.document({
  html: '<html><body><h1>Test</h1></body></html>',
  silent: true, widthMm: 80, heightMm: 300, copies: 1
}));
ok('a print request returns a result rather than hanging', typeof printAttempt.ok === 'boolean');
ok('a failure explains itself', printAttempt.ok || typeof printAttempt.message === 'string', JSON.stringify(printAttempt));

const settingsShape = await page.evaluate(async () => {
  const { printerSettings } = await import('app://local/src/print/printer.js');
  const s = printerSettings(window.__hms.store);
  return { width: s.widthMm, silent: typeof s.silentPrint, name: typeof s.printerName };
});
ok('printer settings expose the silent-print flag', settingsShape.silent === 'boolean');
ok('printer settings expose the printer name', settingsShape.name === 'string');

/* ------------------------------------------------------------------ files */

suite('File bridge');
const backupWrite = await page.evaluate(() => window.hostApi.file.autoBackup({
  filename: 'electron-test-backup.json',
  content: JSON.stringify({ format: 'hms-offline-backup', test: true })
}));
ok('an automatic backup writes to disk', backupWrite.ok === true, backupWrite.message);
ok('and it reports where it landed', typeof backupWrite.path === 'string' && backupWrite.path.length > 0);
if (backupWrite.ok) {
  const onDisk = JSON.parse(readFileSync(backupWrite.path, 'utf8'));
  ok('the file on disk has the right contents', onDisk.format === 'hms-offline-backup');
}

/* ---------------------------------------------------------------- health */

suite('Console health');
const realErrors = pageErrors.filter(e => !/ERR_CERT|Failed to load resource|Autofill/i.test(e));
ok('no uncaught errors in the desktop renderer', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

const info = await page.evaluate(() => window.hostApi.app.info());
ok('the app reports its version', /^\d+\.\d+\.\d+$/.test(info.version), info.version);
ok('the app reports the Electron version', !!info.electron);
console.log(`    \x1b[2mElectron ${info.electron} · Chromium ${info.chrome}\x1b[0m`);

await app.close();
try { rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('\n' + '─'.repeat(62));
if (failed === 0) console.log(`\x1b[32m\x1b[1mAll ${passed} desktop checks passed.\x1b[0m`);
else { console.log(`\x1b[31m\x1b[1m${failed} failed\x1b[0m, ${passed} passed.\n`);
  failures.forEach(f => console.log('  \x1b[31m•\x1b[0m ' + f)); }
console.log('─'.repeat(62));
process.exit(failed === 0 ? 0 : 1);
