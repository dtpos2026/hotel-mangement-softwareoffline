/**
 * Licence model and the local cache.
 *
 * The cryptographic offline scheme was replaced by Firebase verification, so
 * what matters now is: keys are well formed and forgiving to type, the record
 * rules (revoked / expired / bound to another computer) are right, and the
 * local cache cannot be copied to another machine or edited by hand.
 */

import { installBrowserGlobals, suite, ok, eq, report } from './harness.js';
installBrowserGlobals();

const m = await import('../src/core/licence-model.js');
const { LicenceStore } = await import('../electron/licence-store.cjs');
const { toFirestore, fromFirestore } = await import('../electron/firebase-rest.cjs');
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

/* ------------------------------------------------------------------ keys */

suite('Licence keys');

const key = m.generateKey();
ok('a key has the expected shape', /^HR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(key), key);
ok('a key is short enough to read out', key.length === 17, String(key.length));
ok('a key avoids ambiguous characters', !/[ILOU]/.test(key.replace(/^HR/, '')));
ok('a fresh key is well formed', m.isWellFormed(key));

const keys = new Set();
for (let i = 0; i < 5000; i++) keys.add(m.generateKey());
eq('5000 generated keys are all distinct', keys.size, 5000);

eq('formatting round-trips', m.formatKey(m.normaliseKey(key)), key);
eq('lower case input is accepted', m.formatKey(key.toLowerCase()), key);
eq('spaces and missing dashes are forgiven', m.formatKey('hr ' + m.normaliseKey(key)), key);
eq('a mis-read I becomes 1', m.normaliseKey('HR-I234-5678-9ABC'), '123456789ABC');
eq('a mis-read O becomes 0', m.normaliseKey('HR-O234-5678-9ABC'), '023456789ABC');
ok('a short key is rejected', !m.isWellFormed('HR-1234'));
ok('an empty key is rejected', !m.isWellFormed(''));
ok('a key with invalid characters is rejected', !m.isWellFormed('HR-!!!!-@@@@-####'));
eq('the document id drops the prefix and dashes', m.keyToDocId(key), m.normaliseKey(key));

/* --------------------------------------------------------------- records */

suite('What a licence record means');

const base = () => Object.assign(m.blankRecord(), {
  key, businessName: 'Kalam Continental', ownerName: 'Imran Khan', phone: '0300-1234567',
  plan: 'standard', issuedAt: m.todayStr(), expiresAt: m.addDaysStr(365),
  maxUnits: 25, maxUsers: 5, features: m.PLAN_FEATURES.standard.slice()
});

const THIS_PC = 'machine-aaaa';
const OTHER_PC = 'machine-bbbb';

eq('a fresh licence is usable', m.evaluateRecord(base(), THIS_PC).ok, true);
eq('a missing record is refused', m.evaluateRecord(null, THIS_PC).status, m.STATUS.NOT_FOUND);
ok('the not-found message tells the user what to check',
  /typed exactly/i.test(m.evaluateRecord(null, THIS_PC).message));

const revoked = Object.assign(base(), { revoked: true });
eq('a revoked licence is refused', m.evaluateRecord(revoked, THIS_PC).status, m.STATUS.REVOKED);

const expired = Object.assign(base(), { expiresAt: m.addDaysStr(-1) });
eq('an expired licence is refused', m.evaluateRecord(expired, THIS_PC).status, m.STATUS.EXPIRED);
ok('the expiry message names the date', m.evaluateRecord(expired, THIS_PC).message.includes(m.addDaysStr(-1)));

const lastDay = Object.assign(base(), { expiresAt: m.todayStr() });
eq('a licence is still good on its final day', m.evaluateRecord(lastDay, THIS_PC).ok, true);
eq('and it reports zero days left', m.evaluateRecord(lastDay, THIS_PC).daysLeft, 0);

const soon = Object.assign(base(), { expiresAt: m.addDaysStr(10) });
ok('a licence expiring within two weeks is flagged', m.evaluateRecord(soon, THIS_PC).expiringSoon === true);
ok('a licence with a year left is not flagged', m.evaluateRecord(base(), THIS_PC).expiringSoon === false);

const perpetual = Object.assign(base(), { expiresAt: '', plan: 'lifetime' });
eq('a licence with no expiry never expires', m.evaluateRecord(perpetual, THIS_PC).ok, true);
eq('and it shows as Never', m.describeRecord(perpetual).expires, 'Never');

const unbound = base();
ok('an unactivated licence reports first activation', m.evaluateRecord(unbound, THIS_PC).firstActivation === true);

const bound = Object.assign(base(), { machineId: THIS_PC });
eq('a bound licence works on its own computer', m.evaluateRecord(bound, THIS_PC).ok, true);
ok('and it is no longer a first activation', m.evaluateRecord(bound, THIS_PC).firstActivation === false);
eq('a bound licence is refused elsewhere', m.evaluateRecord(bound, OTHER_PC).status, m.STATUS.WRONG_MACHINE);
ok('the wrong-computer message offers a way out',
  /contact your supplier/i.test(m.evaluateRecord(bound, OTHER_PC).message));

suite('What the licence screen shows');
const shown = m.describeRecord(base());
eq('the business name is carried', shown.businessName, 'Kalam Continental');
eq('the owner name is carried', shown.ownerName, 'Imran Khan');
eq('the phone is carried', shown.phone, '0300-1234567');
eq('the plan is shown by label', shown.plan, 'Standard');
eq('unit limits are shown', shown.units, '25');
eq('zero units reads as unlimited', m.describeRecord(Object.assign(base(), { maxUnits: 0 })).units, 'Unlimited');
ok('features are shown as readable labels', shown.featureLabels.includes('Reports and CSV export'));

for (const plan of m.PLANS) {
  const r = Object.assign(base(), { plan: plan.key, features: m.PLAN_FEATURES[plan.key] });
  eq(`${plan.label} describes correctly`, m.describeRecord(r).plan, plan.label);
}

/* ------------------------------------------------------------ local cache */

suite('The local cache cannot be moved or edited');

const dir = mkdtempSync(join(tmpdir(), 'hr-lic-'));
const record = base();

const store = new LicenceStore(dir, THIS_PC);
eq('a new install has no licence', store.activated, false);
ok('first run is stamped', !!store.ensureFirstRun());

store.save(key, record);
eq('after activation it is licensed', store.activated, true);
eq('the record is kept', store.record.businessName, 'Kalam Continental');

const reopened = new LicenceStore(dir, THIS_PC);
eq('the licence survives a restart', reopened.activated, true);
eq('and keeps its business name', reopened.record.businessName, 'Kalam Continental');

const onOtherPc = new LicenceStore(dir, OTHER_PC);
eq('the cache is refused on another computer', onOtherPc.activated, false);
eq('and that is reported as tampering', onOtherPc.tampered, true);

// Hand-edit the expiry, the obvious attack.
const file = join(dir, 'licence.json');
const raw = JSON.parse(readFileSync(file, 'utf8'));
raw.payload.record.expiresAt = '2099-12-31';
writeFileSync(file, JSON.stringify(raw));
const edited = new LicenceStore(dir, THIS_PC);
eq('an edited cache is refused', edited.activated, false);
eq('and it is reported as tampering', edited.tampered, true);

// Removing the HMAC entirely should not help either.
writeFileSync(file, JSON.stringify({ payload: raw.payload }));
eq('a cache with no signature is refused', new LicenceStore(dir, THIS_PC).activated, false);

// Deactivation clears it.
const clean = new LicenceStore(dir, THIS_PC);
clean.save(key, record);
clean.clear();
eq('deactivation removes the licence', clean.activated, false);
ok('but the first-run stamp is kept', !!clean.state.firstRunAt);

suite('Re-check timing');
const fresh = new LicenceStore(dir, THIS_PC);
fresh.save(key, record);
eq('a just-activated licence needs no re-check', fresh.shouldRecheck(), false);
eq('and is well inside the grace period', fresh.pastGrace(), false);
fresh.state.lastVerifiedAt = new Date(Date.now() - 9 * 86400000).toISOString();
eq('after nine days a re-check is due', fresh.shouldRecheck(), true);
eq('but it still works offline', fresh.pastGrace(), false);
fresh.state.lastVerifiedAt = new Date(Date.now() - 60 * 86400000).toISOString();
eq('after sixty days offline a re-check is required', fresh.pastGrace(), true);

rmSync(dir, { recursive: true, force: true });

/* ------------------------------------------------------- Firestore values */

suite('Firestore value conversion');
const sample = {
  key, businessName: 'Kalam Continental', maxUnits: 25, revoked: false,
  features: ['reports', 'expenses'], nested: { a: 1, b: 'two' }
};
eq('values survive a round trip', fromFirestore(toFirestore(sample)), sample);
eq('an integer stays an integer', fromFirestore(toFirestore({ n: 42 })).n, 42);
eq('a boolean stays a boolean', fromFirestore(toFirestore({ b: false })).b, false);
eq('an empty array survives', fromFirestore(toFirestore({ a: [] })).a, []);
eq('null survives', fromFirestore(toFirestore({ v: null })).v, null);

suite('Firebase errors say what to do about them');

// These reach the activation screen, where "ADMIN_ONLY_OPERATION" means
// nothing to a hotel owner. Each one is a setting somebody has to go and
// change, so the message has to name it.
const { FirebaseRest } = await import('../electron/firebase-rest.cjs');

async function errorFor(status, body) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
  try {
    const fb = new FirebaseRest({ apiKey: 'k', projectId: 'p' });
    await fb.ensureToken();
    return null;
  } catch (err) {
    return err;
  } finally {
    globalThis.fetch = real;
  }
}

const anonOff = await errorFor(400, { error: { message: 'ADMIN_ONLY_OPERATION' } });
ok('anonymous sign-in being switched off is explained, not echoed',
  anonOff && anonOff.message.indexOf('ADMIN_ONLY_OPERATION') === -1, anonOff && anonOff.message);
ok('...it names Anonymous sign-in as the thing to enable',
  anonOff && /Anonymous/.test(anonOff.message));
ok('...it names where to do it',
  anonOff && /Authentication/.test(anonOff.message) && /Sign-in method/.test(anonOff.message));
ok('...and the raw code is kept for support',
  anonOff && anonOff.raw === 'ADMIN_ONLY_OPERATION');

const notAllowed = await errorFor(400, { error: { message: 'OPERATION_NOT_ALLOWED' } });
ok('a disallowed sign-in method is explained too',
  notAllowed && /Anonymous/.test(notAllowed.message), notAllowed && notAllowed.message);

const badKey = await errorFor(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
ok('an invalid API key tells the customer to contact their supplier',
  badKey && /supplier/.test(badKey.message), badKey && badKey.message);

const denied = await errorFor(403, { error: { message: 'PERMISSION_DENIED' } });
ok('a refused request points at the security rules',
  denied && /rules/.test(denied.message), denied && denied.message);

const unknown = await errorFor(500, { error: { message: 'Backend exploded' } });
ok('anything unrecognised is still reported, with its label',
  unknown && unknown.message.indexOf('Backend exploded') > -1, unknown && unknown.message);

process.exit(report() === 0 ? 0 : 1);
