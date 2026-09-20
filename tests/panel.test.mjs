/**
 * The licence panel, driven in a real browser with Firebase stubbed out.
 *
 * Every Identity Toolkit and Firestore call is intercepted and answered from
 * an in-memory collection, so the whole flow — sign in, list, create, revoke,
 * renew, release, delete — runs without touching the real project. The stub
 * answers in Firestore's own wire format, which means the value conversion is
 * under test too.
 *
 * Run with: npm run test:panel  (serves admin-panel/ itself)
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, normalize } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname, 'admin-panel');
const PORT = Number(process.env.PANEL_PORT || 8766);

let passed = 0, failed = 0;
const failures = [];
let suiteName = '';
const suite = n => { suiteName = n; console.log('\n\x1b[1m' + n + '\x1b[0m'); };
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; failures.push(suiteName + ' › ' + label + (detail ? ' (' + detail + ')' : ''));
         console.log('  \x1b[31m✗ ' + label + '\x1b[0m' + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
};

/* ------------------------------------------------------- a static server */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = join(ROOT, normalize(path === '/' ? '/index.html' : path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------- the Firebase stub */

const ADMIN_EMAIL = 'owner@gmail.com';
const ADMIN_PASSWORD = 'panel-pass-1';
/** docId -> plain record. The stub converts to wire format on the way out. */
const docs = new Map();

docs.set('4F2K9XQP7M3A', {
  key: 'HR-4F2K-9XQP-7M3A', businessName: 'Kalam Continental', ownerName: 'Zahid Ullah',
  phone: '0300-1234567', city: 'Kalam', email: 'zahid@example.com',
  plan: 'professional', issuedAt: '2026-01-10T09:00:00.000Z', expiresAt: '2027-01-10',
  maxUnits: 100, maxUsers: 15, features: ['reports', 'expenses'], notes: 'Invoice 1041',
  revoked: false, machineId: 'a'.repeat(64), machineCode: 'A1B2-C3D4-E5F6',
  activatedAt: '2026-01-11T10:00:00.000Z', lastSeenAt: '2026-09-01T10:00:00.000Z', issuedBy: ADMIN_EMAIL
});
docs.set('7QW3RT88KMNP', {
  key: 'HR-7QW3-RT88-KMNP', businessName: 'Madyan Guest House', ownerName: 'Imran Khan',
  phone: '0333-9876543', city: 'Madyan', email: '',
  plan: 'trial', issuedAt: '2026-08-01T09:00:00.000Z', expiresAt: '2026-08-31',
  maxUnits: 10, maxUsers: 2, features: ['reports'], notes: '',
  revoked: false, machineId: '', machineCode: '', activatedAt: '', lastSeenAt: '', issuedBy: ADMIN_EMAIL
});

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') {
    const fields = {}; for (const k of Object.keys(v)) fields[k] = toValue(v[k]); return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
const toFields = o => { const f = {}; for (const k of Object.keys(o)) f[k] = toValue(o[k]); return f; };
const docName = id => `projects/dt-hotel-mangemnet/databases/(default)/documents/licences/${id}`;

let lastPatch = null;
let signInAttempts = 0;

const json = (route, body, status) => route.fulfill({
  status: status || 200, contentType: 'application/json', body: JSON.stringify(body)
});

async function stub(route) {
  const req = route.request();
  const url = req.url();
  const body = req.postData() ? safeJson(req.postData()) : null;

  if (url.includes('accounts:signInWithPassword')) {
    signInAttempts++;
    if (body.email !== ADMIN_EMAIL || body.password !== ADMIN_PASSWORD) {
      return json(route, { error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, 400);
    }
    return json(route, { email: body.email, idToken: 'id-token', refreshToken: 'refresh-token', expiresIn: '3600', localId: 'uid1' });
  }
  if (url.includes('accounts:sendOobCode')) return json(route, { email: body.email });
  if (url.includes('accounts:update')) return json(route, { idToken: 'id-token-2', refreshToken: 'refresh-token', expiresIn: '3600' });
  if (url.includes('securetoken.googleapis.com')) {
    return json(route, { id_token: 'id-token', refresh_token: 'refresh-token', expires_in: '3600' });
  }

  if (url.includes(':runQuery')) {
    const rows = [...docs.entries()]
      .sort((a, b) => String(b[1].issuedAt).localeCompare(String(a[1].issuedAt)))
      .map(([id, rec]) => ({ document: { name: docName(id), fields: toFields(rec) } }));
    return json(route, rows);
  }

  const m = /\/documents\/licences(?:\/([^?]+))?/.exec(url);
  if (m) {
    const id = m[1] ? decodeURIComponent(m[1]) : null;

    if (req.method() === 'POST') {                        // create at a chosen id
      const newId = new URL(url).searchParams.get('documentId');
      if (docs.has(newId)) return json(route, { error: { message: 'ALREADY_EXISTS' } }, 409);
      const rec = fromFields(body.fields);
      docs.set(newId, rec);
      return json(route, { name: docName(newId), fields: toFields(rec) });
    }
    if (req.method() === 'PATCH') {
      const rec = docs.get(id);
      if (!rec) return json(route, { error: { message: 'NOT_FOUND' } }, 404);
      const patch = fromFields(body.fields);
      lastPatch = { id, patch };
      Object.assign(rec, patch);
      return json(route, { name: docName(id), fields: toFields(rec) });
    }
    if (req.method() === 'DELETE') { docs.delete(id); return json(route, {}); }
    if (req.method() === 'GET') {
      const rec = docs.get(id);
      if (!rec) return json(route, { error: { message: 'NOT_FOUND' } }, 404);
      return json(route, { name: docName(id), fields: toFields(rec) });
    }
  }

  return json(route, { error: { message: 'unexpected call: ' + url } }, 500);
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(f) { const o = {}; for (const k of Object.keys(f || {})) o[k] = fromValue(f[k]); return o; }

/* ------------------------------------------------------------------ run */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });

await page.route('**identitytoolkit.googleapis.com/**', stub);
await page.route('**securetoken.googleapis.com/**', stub);
await page.route('**firestore.googleapis.com/**', stub);

const text = () => page.evaluate(() => document.body.innerText);
const toastText = () => page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map(t => t.innerText).join('\n'));
const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));

await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

suite('Sign in');
ok('the panel opens on a sign-in screen', await page.locator('.signin').count() === 1);
ok('it does not leak the licence list before sign-in', !(await text()).includes('Kalam Continental'));

await page.fill('input[type=email]', ADMIN_EMAIL);
await page.fill('input[type=password]', 'not-the-password');
await page.click('button[type=submit]');
await page.waitForTimeout(400);
ok('a wrong password is refused in plain words',
  (await page.locator('.signin__msg').innerText()).includes('do not match'));
ok('still on the sign-in screen after a refusal', await page.locator('.signin').count() === 1);

await page.fill('input[type=email]', ADMIN_EMAIL);
await page.fill('input[type=password]', ADMIN_PASSWORD);
await page.click('button[type=submit]');
await page.waitForTimeout(700);
ok('the right password gets in', await page.locator('.shell').count() === 1);
ok('the signed-in account is shown', (await page.locator('.who__mail').innerText()) === ADMIN_EMAIL);

suite('The licence list');
ok('both licences are listed', await page.locator('.row').count() === 2);
ok('the newest licence is first',
  (await page.locator('.row').first().innerText()).includes('Madyan'));
ok('a key is shown in its readable form',
  (await page.locator('.row .key').first().innerText()).startsWith('HR-'));
ok('an expired trial is marked expired',
  (await page.locator('.row').first().innerText()).toLowerCase().includes('expired'));
ok('an activated licence is marked active',
  (await page.locator('.row').nth(1).innerText()).toLowerCase().includes('active'));

const stats = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.stat')).map(s => s.innerText.replace(/\n/g, ' ')));
ok('the totals add up', stats[0].startsWith('2'), stats.join(' | '));
ok('the row count beside the search box is filled in on first render',
  (await page.locator('.toolbar__count').innerText()) === '2 of 2');

suite('Search and filters');
await page.fill('.input--search', 'madyan');
await page.waitForTimeout(250);
ok('searching by business name narrows the list', await page.locator('.row').count() === 1);
ok('the count follows the search', (await page.locator('.toolbar__count').innerText()) === '1 of 2');
await page.fill('.input--search', '0300-1234567');
await page.waitForTimeout(250);
ok('searching by phone finds the licence', await page.locator('.row').count() === 1);
ok('...and it is the right one', (await page.locator('.row').innerText()).includes('Kalam'));
await page.fill('.input--search', 'hr-4f2k');
await page.waitForTimeout(250);
ok('searching by a partial key works, in any case', await page.locator('.row').count() === 1);
await page.fill('.input--search', 'nothing-matches-this');
await page.waitForTimeout(250);
ok('a search with no matches says so', (await text()).includes('No licence matches'));
await page.fill('.input--search', '');
await page.waitForTimeout(250);

await page.locator('.stat', { hasText: 'Not activated' }).click();
await page.waitForTimeout(250);
ok('filtering by "not activated" excludes the activated one', await page.locator('.row').count() === 0);
await page.locator('.stat', { hasText: 'All licences' }).click();
await page.waitForTimeout(250);
ok('clearing the filter brings them back', await page.locator('.row').count() === 2);

suite('Creating a licence');
await page.locator('.topbar button', { hasText: 'New licence' }).click();
await page.waitForTimeout(300);
ok('the form opens', await page.locator('.modal__title').innerText() === 'New licence');

await page.locator('.modal button', { hasText: 'Create licence' }).click();
await page.waitForTimeout(250);
ok('an empty form is refused', (await page.locator('.form__msg').innerText()).includes('business name'));

const fill = async (label, value) => {
  const box = page.locator('.modal .field', { hasText: label }).first();
  await box.locator('input, textarea').first().fill(value);
};
await fill('Hotel / business name', 'Bahrain Riverside Resort');
await page.locator('.modal button', { hasText: 'Create licence' }).click();
await page.waitForTimeout(250);
ok('the owner name is required too', (await page.locator('.form__msg').innerText()).includes('owner name'));

await fill('Owner name', 'Fazal Rahman');
await page.locator('.modal button', { hasText: 'Create licence' }).click();
await page.waitForTimeout(250);
ok('the phone number is required, because the key goes out on WhatsApp',
  (await page.locator('.form__msg').innerText()).includes('phone number'));

await fill('Phone number', '0301-1');
await page.locator('.modal button', { hasText: 'Create licence' }).click();
await page.waitForTimeout(250);
ok('an obviously short number is caught',
  (await page.locator('.form__msg').innerText()).includes('too short'));

await fill('Phone number', '0301-5556677');
await fill('City', 'Bahrain');
const before = docs.size;
await page.locator('.modal button', { hasText: 'Create licence' }).click();
await page.waitForTimeout(900);
ok('the licence was written', docs.size === before + 1);

const created = [...docs.entries()].find(([, r]) => r.businessName === 'Bahrain Riverside Resort');
ok('the key is a well-formed 12-character key', /^[0-9A-HJKMNP-TV-Z]{12}$/.test(created[0]), created[0]);
ok('the stored key matches its document id', created[1].key.replace(/-/g, '') === 'HR' + created[0]);
ok('the owner details were stored', created[1].ownerName === 'Fazal Rahman' && created[1].phone === '0301-5556677');
ok('a new licence is not bound to any computer', created[1].machineId === '');
ok('the issuing admin is recorded', created[1].issuedBy === ADMIN_EMAIL);
ok('it is stamped with an issue date', String(created[1].issuedAt).length > 10);
ok('the plan default carried through', created[1].plan === 'standard' && created[1].maxUnits === 25);
ok('an expiry a year out was set', created[1].expiresAt && created[1].expiresAt.length === 10);
ok('a confirmation is shown', (await toastText()).includes('created'));
await clearToasts();

ok('the new licence opens in the drawer', await page.locator('.drawer').count() === 1);
ok('the drawer shows the key in full',
  (await page.locator('.keybox__key').innerText()) === created[1].key);
ok('an unactivated licence says so', (await page.locator('.drawer').innerText()).includes('Not activated yet'));

const wa = await page.locator('.btn--wa').getAttribute('href');
ok('the WhatsApp link normalises the local number to +92', wa.includes('wa.me/923015556677'), wa);
ok('the WhatsApp message carries the key', decodeURIComponent(wa).includes(created[1].key));

suite('Managing a licence');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
await page.locator('.row', { hasText: 'Kalam Continental' }).click();
await page.waitForTimeout(300);
ok('the drawer opens on the chosen licence',
  (await page.locator('.drawer__title').innerText()) === 'Kalam Continental');
ok('the bound computer is shown', (await page.locator('.drawer').innerText()).includes('A1B2-C3D4-E5F6'));
ok('the plan is named', (await page.locator('.drawer').innerText()).includes('Professional'));

// Revoke
await page.locator('.drawer button', { hasText: 'Revoke' }).click();
await page.waitForTimeout(250);
ok('revoking asks first', (await page.locator('.modal__title').innerText()) === 'Are you sure?');
await page.locator('.modal button', { hasText: 'Yes, go ahead' }).click();
await page.waitForTimeout(800);
ok('the licence is revoked upstream', docs.get('4F2K9XQP7M3A').revoked === true);
ok('only the revoked flag was written', Object.keys(lastPatch.patch).join(',') === 'revoked');
ok('the drawer now offers to restore it',
  await page.locator('.drawer button', { hasText: 'Restore licence' }).count() === 1);
await clearToasts();

await page.locator('.drawer button', { hasText: 'Restore licence' }).click();
await page.waitForTimeout(800);
ok('restoring puts it back', docs.get('4F2K9XQP7M3A').revoked === false);
await clearToasts();

// Release the machine binding
await page.locator('.drawer button', { hasText: 'Release the computer' }).click();
await page.waitForTimeout(250);
await page.locator('.modal button', { hasText: 'Yes, go ahead' }).click();
await page.waitForTimeout(800);
ok('the machine binding is cleared', docs.get('4F2K9XQP7M3A').machineId === '');
ok('the machine code is cleared with it', docs.get('4F2K9XQP7M3A').machineCode === '');
ok('the customer details are untouched', docs.get('4F2K9XQP7M3A').businessName === 'Kalam Continental');
await clearToasts();

// Renew
await page.locator('.drawer button', { hasText: 'Renew / extend' }).click();
await page.waitForTimeout(300);
ok('renewing explains where the extension starts from',
  (await page.locator('.modal__body').innerText()).includes('runs from'));
await page.locator('.modal button', { hasText: '365 days' }).click();
await page.waitForTimeout(200);
await page.locator('.modal__foot button', { hasText: 'Renew' }).click();
await page.waitForTimeout(800);
const renewed = docs.get('4F2K9XQP7M3A').expiresAt;
ok('the expiry moved a year past the old one', renewed === '2028-01-10', renewed);
await clearToasts();

// Editing
await page.locator('.drawer button', { hasText: 'Edit details' }).click();
await page.waitForTimeout(300);
await fill('Owner name', 'Zahid Ullah Khan');
await page.locator('.modal__foot button', { hasText: 'Save changes' }).click();
await page.waitForTimeout(800);
ok('the edit was saved', docs.get('4F2K9XQP7M3A').ownerName === 'Zahid Ullah Khan');
ok('editing never touches the machine binding', !('machineId' in lastPatch.patch));
ok('editing never touches the key', !('key' in lastPatch.patch));
await clearToasts();

// Deleting
suite('Deleting');
const countBefore = docs.size;
await page.locator('.drawer button', { hasText: 'Delete' }).click();
await page.waitForTimeout(250);
ok('deleting warns that revoking is usually better',
  (await page.locator('.modal__body').innerText()).includes('Revoking is usually'));
await page.locator('.modal button', { hasText: 'Yes, go ahead' }).click();
await page.waitForTimeout(800);
ok('the licence is gone', docs.size === countBefore - 1);
ok('the drawer closed', await page.locator('.drawer').count() === 0);
await clearToasts();

suite('The session');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);
ok('the session survives a reload', await page.locator('.shell').count() === 1);
ok('no second sign-in was needed', signInAttempts === 2, 'attempts: ' + signInAttempts);

await page.locator('.who button', { hasText: 'Sign out' }).click();
await page.waitForTimeout(400);
ok('signing out returns to the sign-in screen', await page.locator('.signin').count() === 1);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
ok('signing out really ended the session', await page.locator('.signin').count() === 1);

if (process.env.SHOT) {
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: process.env.SHOT + '/panel-signin.png' });
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForTimeout(900);
  await clearToasts();
  await page.screenshot({ path: process.env.SHOT + '/panel-list.png' });
  await page.locator('.row').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: process.env.SHOT + '/panel-drawer.png' });
  await page.keyboard.press('Escape');
  await page.locator('.topbar button', { hasText: 'New licence' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: process.env.SHOT + '/panel-new.png' });
  await page.keyboard.press('Escape');
}

suite('Page health');
ok('no script errors anywhere in that run', errs.length === 0, errs.join(' | '));

/* --------------------------------------------------------------- report */

console.log('\n' + '─'.repeat(60));
if (failed) {
  console.log(`\x1b[31m\x1b[1m${failed} check(s) failed.\x1b[0m`);
  failures.forEach(f => console.log('  \x1b[31m•\x1b[0m ' + f));
} else {
  console.log(`\x1b[32m\x1b[1mAll ${passed} panel checks passed.\x1b[0m`);
}
console.log('─'.repeat(60));

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
