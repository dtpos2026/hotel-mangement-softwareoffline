/**
 * Offline licence format.
 *
 * A licence is a 26-byte payload plus a 64-byte Ed25519 signature, encoded as
 * Crockford Base32. The vendor holds the private key; the application embeds
 * only the public key, so a licence can be verified with no internet, no
 * server and no shared secret that could be extracted from the installer and
 * used to mint keys.
 *
 * This module is pure: it encodes, decodes, describes and date-checks. The
 * actual signature check is done by a verifier injected by the host —
 * node:crypto in the Electron main process, WebCrypto in the browser — because
 * the two platforms expose Ed25519 differently.
 */

/* ------------------------------------------------------------- constants */

// Crockford Base32: no I, L, O or U, so a key cannot be mis-read or mis-typed.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DECODE = (() => {
  const map = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = i;
  // Forgive the characters Crockford deliberately dropped.
  map.I = 1; map.L = 1; map.O = 0; map.U = map.V;
  return map;
})();

export const PAYLOAD_BYTES = 26;
export const SIGNATURE_BYTES = 64;
export const KEY_BYTES = PAYLOAD_BYTES + SIGNATURE_BYTES;   // 90
export const FORMAT_VERSION = 1;

/** Day 0 of the licence calendar. Keeps dates inside a uint16 until 2203. */
const EPOCH = Date.UTC(2024, 0, 1);
const MS_DAY = 86400000;

export const PLANS = [
  { id: 0, key: 'trial',        label: 'Trial',        days: 30,  maxUnits: 10,  maxUsers: 2 },
  { id: 1, key: 'standard',     label: 'Standard',     days: 365, maxUnits: 25,  maxUsers: 5 },
  { id: 2, key: 'professional', label: 'Professional', days: 365, maxUnits: 100, maxUsers: 15 },
  { id: 3, key: 'enterprise',   label: 'Enterprise',   days: 365, maxUnits: 0,   maxUsers: 0 },
  { id: 4, key: 'lifetime',     label: 'Lifetime',     days: 0,   maxUnits: 0,   maxUsers: 0 }
];

/**
 * Feature bits. Everything a plan can switch on lives here, including the
 * modules that do not exist yet — reserving the bit now means an old installer
 * will not misread a licence issued later.
 */
export const FEATURES = [
  { bit: 0,  key: 'reports',        label: 'Reports and CSV export' },
  { bit: 1,  key: 'expenses',       label: 'Expenses and cash book' },
  { bit: 2,  key: 'housekeeping',   label: 'Housekeeping and maintenance' },
  { bit: 3,  key: 'dayClose',       label: 'Daily closing' },
  { bit: 4,  key: 'userManagement', label: 'Multiple users and roles' },
  { bit: 5,  key: 'backupRestore',  label: 'Backup and restore' },
  { bit: 6,  key: 'advancedReports',label: 'Unit performance and guest history' },
  { bit: 7,  key: 'multiProperty',  label: 'Multiple properties' },
  { bit: 8,  key: 'restaurant',     label: 'Restaurant POS (planned)' },
  { bit: 9,  key: 'channelManager', label: 'Channel manager (planned)' },
  { bit: 10, key: 'onlineBooking',  label: 'Online booking (planned)' },
  { bit: 11, key: 'cloudSync',      label: 'Cloud sync (planned)' }
];

/** What each plan turns on by default. The panel may override per licence. */
export const PLAN_FEATURES = {
  trial:        ['reports', 'expenses', 'housekeeping', 'dayClose', 'backupRestore'],
  standard:     ['reports', 'expenses', 'housekeeping', 'dayClose', 'backupRestore', 'userManagement'],
  professional: ['reports', 'expenses', 'housekeeping', 'dayClose', 'backupRestore', 'userManagement', 'advancedReports'],
  enterprise:   ['reports', 'expenses', 'housekeeping', 'dayClose', 'backupRestore', 'userManagement', 'advancedReports', 'multiProperty'],
  lifetime:     ['reports', 'expenses', 'housekeeping', 'dayClose', 'backupRestore', 'userManagement', 'advancedReports', 'multiProperty']
};

export function planByKey(key) { return PLANS.find(p => p.key === key) || PLANS[0]; }
export function planById(id) { return PLANS.find(p => p.id === id) || PLANS[0]; }

export function featuresToMask(keys) {
  let mask = 0;
  for (const key of keys || []) {
    const f = FEATURES.find(x => x.key === key);
    if (f) mask |= (1 << f.bit);
  }
  return mask & 0xFFFF;
}

export function maskToFeatures(mask) {
  return FEATURES.filter(f => (mask & (1 << f.bit)) !== 0).map(f => f.key);
}

/* ------------------------------------------------------------- date maths */

export function dateToDay(dateStr) {
  if (!dateStr) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!m) return 0;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const day = Math.round((t - EPOCH) / MS_DAY);
  return day > 0 && day < 65535 ? day : 0;
}

export function dayToDate(day) {
  if (!day) return '';
  const d = new Date(EPOCH + day * MS_DAY);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function todayDay() {
  const now = new Date();
  return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - EPOCH) / MS_DAY);
}

/* ------------------------------------------------------------- base32 */

export function toBase32(bytes) {
  let out = '', bits = 0, value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text) {
  const clean = String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const bytes = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const v = DECODE[ch];
    if (v === undefined) throw new Error('This licence key contains characters that are not part of a key.');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xFF); bits -= 8; }
  }
  return new Uint8Array(bytes);
}

/* ------------------------------------------------------------- payload */

function writeU16(view, offset, value) { view.setUint16(offset, value & 0xFFFF, false); }
function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, false); }

/**
 * Builds the 26-byte payload. `customerHash` and `machineHash` are supplied by
 * the caller because hashing needs a platform crypto API.
 */
export function buildPayload(fields) {
  const buf = new Uint8Array(PAYLOAD_BYTES);
  const view = new DataView(buf.buffer);
  const plan = planByKey(fields.plan);

  buf[0] = FORMAT_VERSION;
  buf[1] = plan.id;
  writeU16(view, 2, fields.issuedDay || todayDay());
  writeU16(view, 4, fields.expiryDay || 0);
  writeU16(view, 6, Number(fields.maxUnits) || 0);
  writeU16(view, 8, Number(fields.maxUsers) || 0);
  writeU16(view, 10, featuresToMask(fields.features));
  writeU32(view, 12, Number(fields.licenceNo) || 0);
  (fields.customerHash || new Uint8Array(6)).slice(0, 6).forEach((b, i) => { buf[16 + i] = b; });
  (fields.machineHash || new Uint8Array(4)).slice(0, 4).forEach((b, i) => { buf[22 + i] = b; });
  return buf;
}

export function readPayload(buf) {
  if (!buf || buf.length < PAYLOAD_BYTES) throw new Error('This licence key is too short to be valid.');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const plan = planById(buf[1]);
  const expiryDay = view.getUint16(4, false);
  return {
    version: buf[0],
    plan: plan.key,
    planLabel: plan.label,
    issuedDay: view.getUint16(2, false),
    issuedAt: dayToDate(view.getUint16(2, false)),
    expiryDay,
    expiresAt: expiryDay ? dayToDate(expiryDay) : '',
    perpetual: expiryDay === 0,
    maxUnits: view.getUint16(6, false),
    maxUsers: view.getUint16(8, false),
    featureMask: view.getUint16(10, false),
    features: maskToFeatures(view.getUint16(10, false)),
    licenceNo: view.getUint32(12, false),
    customerHash: buf.slice(16, 22),
    machineHash: buf.slice(22, 26),
    machineBound: Array.from(buf.slice(22, 26)).some(b => b !== 0)
  };
}

/* ------------------------------------------------------------- key text */

export function encodeKey(payload, signature) {
  const all = new Uint8Array(KEY_BYTES);
  all.set(payload, 0);
  all.set(signature, PAYLOAD_BYTES);
  return toBase32(all);
}

export function splitKey(text) {
  const bytes = fromBase32(text);
  if (bytes.length < KEY_BYTES) {
    throw new Error(`This licence key is incomplete — it should be ${KEY_BYTES * 8 / 5} characters and this one has ${Math.floor(bytes.length * 8 / 5)}.`);
  }
  return {
    payload: bytes.slice(0, PAYLOAD_BYTES),
    signature: bytes.slice(PAYLOAD_BYTES, KEY_BYTES)
  };
}

/** Groups of 6 across 4 columns — readable over WhatsApp, easy to re-type. */
export function formatKey(raw) {
  const clean = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const groups = clean.match(/.{1,6}/g) || [];
  const lines = [];
  for (let i = 0; i < groups.length; i += 4) lines.push(groups.slice(i, i + 4).join('-'));
  return lines.join('\n');
}

/* ------------------------------------------------------------- checking */

export const STATUS = {
  VALID: 'valid',
  TRIAL: 'trial',
  EXPIRED: 'expired',
  WRONG_MACHINE: 'wrong_machine',
  TAMPERED: 'tampered',
  MALFORMED: 'malformed',
  FUTURE_VERSION: 'future_version',
  NONE: 'none'
};

/**
 * Turns a verified payload into the decision the application acts on.
 * Signature verification must already have passed.
 */
export function evaluate(payload, context) {
  const ctx = context || {};
  const day = ctx.today !== undefined ? ctx.today : todayDay();

  if (payload.version > FORMAT_VERSION) {
    return { ok: false, status: STATUS.FUTURE_VERSION,
      message: 'This licence was issued for a newer version of the software. Please update before activating it.' };
  }

  if (payload.machineBound && ctx.machineHash) {
    const same = Array.from(payload.machineHash).every((b, i) => b === ctx.machineHash[i]);
    if (!same) {
      return { ok: false, status: STATUS.WRONG_MACHINE,
        message: 'This licence is registered to a different computer. Contact your supplier to move it.' };
    }
  }

  if (!payload.perpetual && payload.expiryDay < day) {
    return { ok: false, status: STATUS.EXPIRED, expiresAt: payload.expiresAt,
      message: `This licence expired on ${payload.expiresAt}. Contact your supplier to renew it.` };
  }

  const daysLeft = payload.perpetual ? null : payload.expiryDay - day;
  return {
    ok: true,
    status: payload.plan === 'trial' ? STATUS.TRIAL : STATUS.VALID,
    daysLeft,
    expiringSoon: daysLeft !== null && daysLeft <= 14,
    message: payload.perpetual
      ? `${payload.planLabel} licence — no expiry.`
      : `${payload.planLabel} licence — ${daysLeft} day(s) remaining.`
  };
}

/** Plain-language description for the activation screen and Settings. */
export function describe(payload) {
  return {
    plan: payload.planLabel,
    licenceNo: payload.licenceNo ? String(payload.licenceNo).padStart(5, '0') : '—',
    issued: payload.issuedAt || '—',
    expires: payload.perpetual ? 'Never' : (payload.expiresAt || '—'),
    units: payload.maxUnits === 0 ? 'Unlimited' : String(payload.maxUnits),
    users: payload.maxUsers === 0 ? 'Unlimited' : String(payload.maxUsers),
    machineBound: payload.machineBound,
    features: payload.features.map(k => (FEATURES.find(f => f.key === k) || {}).label || k)
  };
}
