/**
 * Licence security properties.
 *
 * The point of a signed offline licence is that a customer who owns the
 * installer still cannot mint or extend one. These checks prove that: every
 * field is covered by the signature, a different keypair is rejected, and the
 * date, machine and version rules all hold.
 */

import { suite, ok, eq, report } from './harness.js';

const lic = await import('../src/core/license.js');
const {
  generateKeypair, signPayload, verifyPayload, customerHash, machineHash, shortHash
} = await import('../tools/licence-crypto.mjs');

const vendor = generateKeypair();
const attacker = generateKeypair();

function issue(fields, keypair) {
  const payload = lic.buildPayload(Object.assign({
    plan: 'standard',
    issuedDay: lic.todayDay(),
    expiryDay: lic.todayDay() + 365,
    maxUnits: 25, maxUsers: 5,
    features: lic.PLAN_FEATURES.standard,
    licenceNo: 1,
    customerHash: customerHash('Kalam Continental'),
    machineHash: new Uint8Array(4)
  }, fields));
  const signature = signPayload(payload, (keypair || vendor).privateKey);
  return { payload, signature, key: lic.encodeKey(payload, signature) };
}

function check(key, context, publicKey) {
  const { payload, signature } = lic.splitKey(key);
  if (!verifyPayload(payload, signature, publicKey || vendor.publicKey)) {
    return { ok: false, status: lic.STATUS.TAMPERED };
  }
  return lic.evaluate(lic.readPayload(payload), context || {});
}

/* -------------------------------------------------------------- encoding */

suite('Key encoding');

const std = issue({});
eq('a key is exactly 144 characters', std.key.length, 144);
ok('a key uses only Crockford Base32', /^[0-9A-HJKMNP-TV-Z]+$/.test(std.key));
ok('a key contains no ambiguous characters', !/[ILOU]/.test(std.key));

const formatted = lic.formatKey(std.key);
eq('a formatted key survives a round trip', lic.fromBase32(formatted).length, lic.KEY_BYTES);
eq('formatting produces 6 readable lines', formatted.split('\n').length, 6);
ok('a key pasted with stray spaces and newlines still parses',
  lic.splitKey('  ' + formatted.replace(/-/g, ' ') + '\n\n').payload.length === lic.PAYLOAD_BYTES);
ok('lower case input is accepted', lic.splitKey(std.key.toLowerCase()).payload.length === lic.PAYLOAD_BYTES);

const parsed = lic.readPayload(std.payload);
eq('the plan round-trips', parsed.plan, 'standard');
eq('the unit limit round-trips', parsed.maxUnits, 25);
eq('the user limit round-trips', parsed.maxUsers, 5);
eq('the features round-trip', parsed.features.sort(), lic.PLAN_FEATURES.standard.slice().sort());
eq('the licence number round-trips', parsed.licenceNo, 1);
eq('the issue date round-trips', parsed.issuedAt, lic.dayToDate(lic.todayDay()));

/* ------------------------------------------------------------- integrity */

suite('A customer cannot forge or extend a licence');

eq('a genuine key verifies', check(std.key).ok, true);

// Flip each byte of the payload in turn: every field must be signed.
let acceptedTampering = 0;
for (let i = 0; i < lic.PAYLOAD_BYTES; i++) {
  const bytes = lic.fromBase32(std.key);
  bytes[i] ^= 0xFF;
  const forged = lic.toBase32(bytes);
  try { if (check(forged).ok) acceptedTampering++; } catch { /* malformed counts as rejected */ }
}
eq('changing any payload byte invalidates the key', acceptedTampering, 0);

// The obvious attacks, spelled out.
const extended = lic.buildPayload({
  plan: 'lifetime', expiryDay: 0, maxUnits: 0, maxUsers: 0,
  features: lic.FEATURES.map(f => f.key), licenceNo: 1,
  customerHash: customerHash('Kalam Continental'), machineHash: new Uint8Array(4)
});
const reusedSig = lic.encodeKey(extended, std.signature);
eq('a payload upgraded to lifetime with the old signature is rejected', check(reusedSig).ok, false);
eq('and it is reported as tampered', check(reusedSig).status, lic.STATUS.TAMPERED);

const selfSigned = issue({ plan: 'lifetime', expiryDay: 0, maxUnits: 0 }, attacker);
eq('a licence signed with another keypair is rejected', check(selfSigned.key).ok, false);
ok('but that same licence verifies under its own key', check(selfSigned.key, {}, attacker.publicKey).ok);

const truncated = lic.toBase32(lic.fromBase32(std.key).slice(0, 80));
let truncatedRejected = false;
try { truncatedRejected = !check(truncated).ok; } catch { truncatedRejected = true; }
ok('a truncated key is rejected', truncatedRejected);

let garbageRejected = false;
try { garbageRejected = !check('HELLO-WORLD-THIS-IS-NOT-A-KEY').ok; } catch { garbageRejected = true; }
ok('random text is rejected', garbageRejected);

/* ------------------------------------------------------------- lifecycle */

suite('Expiry, machine binding and version');

const expired = issue({ expiryDay: lic.todayDay() - 1 });
eq('an expired licence is refused', check(expired.key).ok, false);
eq('and it is reported as expired', check(expired.key).status, lic.STATUS.EXPIRED);
ok('the expiry message names the date', /expired on \d{4}-\d{2}-\d{2}/.test(check(expired.key).message));

const lastDay = issue({ expiryDay: lic.todayDay() });
eq('a licence is still valid on its final day', check(lastDay.key).ok, true);
eq('and it reports zero days left', check(lastDay.key).daysLeft, 0);

const soon = issue({ expiryDay: lic.todayDay() + 7 });
ok('a licence expiring within two weeks is flagged', check(soon.key).expiringSoon === true);
ok('a licence expiring in a year is not flagged', check(std.key).expiringSoon === false);

const perpetual = issue({ plan: 'lifetime', expiryDay: 0 });
eq('a perpetual licence never expires', check(perpetual.key, { today: lic.todayDay() + 40000 }).ok, true);
eq('and it says so', lic.describe(lic.readPayload(perpetual.payload)).expires, 'Never');

const thisPc = machineHash('MACHINE-GUID-AAAA');
const otherPc = machineHash('MACHINE-GUID-BBBB');
const bound = issue({ machineHash: thisPc });
eq('a bound licence works on its own machine', check(bound.key, { machineHash: thisPc }).ok, true);
eq('a bound licence is refused on another machine', check(bound.key, { machineHash: otherPc }).ok, false);
eq('and it says which problem it is', check(bound.key, { machineHash: otherPc }).status, lic.STATUS.WRONG_MACHINE);
eq('an unbound licence works anywhere', check(std.key, { machineHash: otherPc }).ok, true);
ok('binding is visible when inspecting', lic.readPayload(bound.payload).machineBound === true);
ok('an unbound licence reports no binding', lic.readPayload(std.payload).machineBound === false);

const future = issue({});
future.payload[0] = 9;
const futureKey = lic.encodeKey(future.payload, signPayload(future.payload, vendor.privateKey));
eq('a licence from a newer format is refused politely', check(futureKey).status, lic.STATUS.FUTURE_VERSION);

/* --------------------------------------------------------------- plans */

suite('Plans and limits');

for (const plan of lic.PLANS) {
  const p = issue({ plan: plan.key, maxUnits: plan.maxUnits, maxUsers: plan.maxUsers,
                    features: lic.PLAN_FEATURES[plan.key] || [], expiryDay: plan.days ? lic.todayDay() + plan.days : 0 });
  const parsedPlan = lic.readPayload(p.payload);
  eq(`${plan.label} round-trips`, parsedPlan.plan, plan.key);
  eq(`${plan.label} keeps its unit limit`, parsedPlan.maxUnits, plan.maxUnits);
  ok(`${plan.label} verifies`, check(p.key).ok);
}

const unlimited = lic.describe(lic.readPayload(issue({ maxUnits: 0, maxUsers: 0 }).payload));
eq('zero units reads as unlimited', unlimited.units, 'Unlimited');
eq('zero users reads as unlimited', unlimited.users, 'Unlimited');

const everyFeature = issue({ features: lic.FEATURES.map(f => f.key) });
eq('all 12 feature bits survive the round trip',
  lic.readPayload(everyFeature.payload).features.length, lic.FEATURES.length);
const noFeature = issue({ features: [] });
eq('an empty feature set round-trips', lic.readPayload(noFeature.payload).features.length, 0);

suite('Customer identity');
eq('customer hashing ignores case and punctuation',
  Array.from(customerHash('Kalam Continental')).join(),
  Array.from(customerHash('  kalam,  CONTINENTAL ')).join());
ok('different customers hash differently',
  Array.from(customerHash('Kalam Continental')).join() !== Array.from(customerHash('Swat Resort')).join());

process.exit(report() === 0 ? 0 : 1);
