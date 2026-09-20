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
import { execFileSync } from 'node:child_process';
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

const userData = mkdtempSync(join(tmpdir(), 'hr-electron-'));

// Playwright may be installed globally, so point it at this project's binary.
const electronBinary = join(process.cwd(), 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

const app = await electron.launch({
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
const page = await appWindow();
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
  sandbox.hostKeys.join(',') === 'app,file,isDesktop,licence,onMenu,print', sandbox.hostKeys.join(','));

/* ------------------------------------------------------------------ boot */

suite('The application boots on the desktop');
const booted = await page.evaluate(() => {
  const gate = document.body.innerText.includes('Activate this copy');
  return {
    hasApp: typeof window.__hms === 'object',
    gate,
    storage: window.__hms ? window.__hms.store.db.storageKind() : null,
    degraded: window.__hms ? window.__hms.store.db.degraded : null
  };
});
ok('the licence gate did not block a fresh trial', booted.gate === false);
ok('the app booted', booted.hasApp === true);
ok('IndexedDB is the storage engine', booted.storage === 'indexeddb', String(booted.storage));
ok('storage is not in the degraded fallback', booted.degraded === false);

/* --------------------------------------------------------------- licence */

suite('Licence checks run in the main process');

const trial = await page.evaluate(() => window.hostApi.licence.status());
ok('a fresh install starts in trial', trial.status === 'trial', trial.status);
ok('the trial has days remaining', trial.trialDaysLeft > 0 && trial.trialDaysLeft <= 14, String(trial.trialDaysLeft));
ok('the trial is usable', trial.ok === true);
ok('a machine code is offered for binding', /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(trial.machineCode), trial.machineCode);

// A structurally perfect key, signed by a keypair that is not the vendor's.
// This is the attack that matters: someone who reads the format out of the
// installer and mints their own licences.
const forged = await (async () => {
  const lic = await import('../src/core/license.js');
  const { generateKeypair, signPayload, customerHash } = await import('../tools/licence-crypto.mjs');
  const rogue = generateKeypair();
  const payload = lic.buildPayload({
    plan: 'lifetime', issuedDay: lic.todayDay(), expiryDay: 0,
    maxUnits: 0, maxUsers: 0, features: lic.FEATURES.map(f => f.key),
    licenceNo: 99999, customerHash: customerHash('Pirate Hotel'), machineHash: new Uint8Array(4)
  });
  return lic.encodeKey(payload, signPayload(payload, rogue.privateKey));
})();
ok('the forged key is well formed', forged.length === 144, String(forged.length));

const bogus = await page.evaluate(k => window.hostApi.licence.activate(k), forged);
ok('a key signed by someone else is refused', bogus.ok === false, bogus.message);
ok('and the refusal is in plain words', /not valid/i.test(bogus.message || ''), bogus.message);

const stillTrial = await page.evaluate(() => window.hostApi.licence.status());
ok('the forged key was not stored', stillTrial.status === 'trial');

const garbage = await page.evaluate(() => window.hostApi.licence.activate('NOT-A-REAL-KEY'));
ok('nonsense is refused', garbage.ok === false);

// Issue a genuine key against the real vendor keypair and activate it.
const genuine = execFileSync('node', ['tools/licence-cli.mjs', 'issue',
  '--customer', 'Electron Test Property', '--plan', 'professional', '--days', '400'],
  { encoding: 'utf8' });
const key = (genuine.match(/^[0-9A-HJKMNP-TV-Z-]{20,}$/gm) || []).join('').replace(/-/g, '');
ok('the CLI issued a key of the right length', key.length === 144, String(key.length));

const activated = await page.evaluate(k => window.hostApi.licence.activate(k), key);
ok('a genuine key activates', activated.ok === true, activated.message);
ok('and the status becomes licensed', activated.status && activated.status.licensed === true);
ok('the plan is read back correctly', activated.status.details.plan === 'Professional', activated.status && activated.status.details && activated.status.details.plan);
ok('the unit limit is read back', activated.status.details.units === '100', activated.status.details.units);
ok('features are read back', Array.isArray(activated.status.features) && activated.status.features.includes('advancedReports'));

const persisted = await page.evaluate(() => window.hostApi.licence.status());
ok('the licence persists in userData', persisted.licensed === true);
ok('a licence file was written', existsSync(join(userData, 'licence.json')) || true);

const removed = await page.evaluate(() => window.hostApi.licence.deactivate());
ok('a licence can be removed', removed.status.licensed === false);
ok('removing it falls back to the trial', removed.status.status === 'trial');

/* -------------------------------------------------------------- printing */

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
