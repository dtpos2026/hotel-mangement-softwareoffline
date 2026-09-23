/**
 * Licence model, shared by the admin panel and the desktop app.
 *
 * A licence is a record in Firestore, identified by a short human-typeable
 * key. The desktop app verifies that record once over the internet; after that
 * it runs entirely offline from a local cache.
 *
 * The key is short on purpose: a receptionist reads it off a WhatsApp message
 * and types it in. Security does not come from the key being unguessable on
 * its own — it comes from the Firestore rules plus the fact that activating
 * binds the licence to one computer.
 */

/* Crockford Base32 without I, L, O, U — nothing that can be mis-read. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const KEY_PREFIX = 'HR';
export const KEY_GROUPS = 3;
export const KEY_GROUP_LEN = 4;

export const PLANS = [
  { key: 'trial',        label: 'Trial',        days: 30,  maxUnits: 10,  maxUsers: 2 },
  { key: 'standard',     label: 'Standard',     days: 365, maxUnits: 25,  maxUsers: 5 },
  { key: 'professional', label: 'Professional', days: 365, maxUnits: 100, maxUsers: 15 },
  { key: 'enterprise',   label: 'Enterprise',   days: 365, maxUnits: 0,   maxUsers: 0 },
  { key: 'lifetime',     label: 'Lifetime',     days: 0,   maxUnits: 0,   maxUsers: 0 }
];

export const FEATURES = [
  { key: 'reports',         label: 'Reports and CSV export' },
  { key: 'expenses',        label: 'Expenses and cash book' },
  { key: 'housekeeping',    label: 'Housekeeping and maintenance' },
  { key: 'dayClose',        label: 'Daily closing' },
  { key: 'userManagement',  label: 'Multiple users and roles' },
  { key: 'backupRestore',   label: 'Backup and restore' },
  { key: 'advancedReports', label: 'Unit performance and guest history' },
  { key: 'restaurant',      label: 'Restaurant point of sale' },
  { key: 'inventory',       label: 'Stock, purchasing and suppliers' },
  { key: 'multiProperty',   label: 'Multiple properties' }
];

export const PLAN_FEATURES = {
  trial:        ['reports', 'expenses', 'housekeeping', 'dayClose', 'backupRestore'],
  standard:     ['reports', 'expenses', 'housekeeping', 'dayClose', 'backupRestore', 'userManagement'],
  professional: ['reports', 'expenses', 'housekeeping', 'dayClose', 'backupRestore', 'userManagement',
                 'advancedReports', 'restaurant', 'inventory'],
  enterprise:   FEATURES.map(f => f.key),
  lifetime:     FEATURES.map(f => f.key)
};

export function planByKey(key) { return PLANS.find(p => p.key === key) || PLANS[1]; }

/* -------------------------------------------------------------- the key */

/**
 * Generates a key like HR-4F2K-9XQP-7M3A.
 * 12 Crockford characters is 60 bits — far beyond guessing, and short enough
 * to read out over the phone.
 */
export function generateKey(randomBytes) {
  const need = KEY_GROUPS * KEY_GROUP_LEN;
  const bytes = randomBytes
    ? randomBytes(need)
    : (() => {
        const b = new Uint8Array(need);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
        else for (let i = 0; i < need; i++) b[i] = Math.floor(Math.random() * 256);
        return b;
      })();

  let chars = '';
  for (let i = 0; i < need; i++) chars += ALPHABET[bytes[i] % ALPHABET.length];
  const groups = chars.match(new RegExp(`.{1,${KEY_GROUP_LEN}}`, 'g'));
  return KEY_PREFIX + '-' + groups.join('-');
}

/** Strips formatting so 'hr 4f2k9xqp 7m3a' and 'HR-4F2K-9XQP-7M3A' match. */
export function normaliseKey(input) {
  let s = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  // Forgive the characters Crockford drops.
  s = s.replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0');
  if (s.startsWith(KEY_PREFIX)) s = s.slice(KEY_PREFIX.length);
  return s;
}

export function formatKey(input) {
  const body = normaliseKey(input);
  const groups = body.match(new RegExp(`.{1,${KEY_GROUP_LEN}}`, 'g')) || [];
  return KEY_PREFIX + '-' + groups.join('-');
}

export function isWellFormed(input) {
  const body = normaliseKey(input);
  return body.length === KEY_GROUPS * KEY_GROUP_LEN && /^[0-9A-HJKMNP-TV-Z]+$/.test(body);
}

/** Firestore document id for a key. */
export function keyToDocId(input) { return normaliseKey(input); }

/* ------------------------------------------------------------- lifecycle */

export const STATUS = {
  ACTIVE: 'active',
  NOT_FOUND: 'not_found',
  SUSPENDED: 'suspended',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  WRONG_MACHINE: 'wrong_machine',
  MALFORMED: 'malformed',
  OFFLINE: 'offline',
  NONE: 'none'
};

/** Who to call when a licence stops working. */
export const SUPPORT_CONTACT = {
  company: 'Digital Target',
  phone: '+92 345 1873354',
  whatsapp: ['+92 345 1873354', '+92 332 2373354'],
  email: 'digitaltarget.digital@gmail.com',
  facebook: 'https://web.facebook.com/digitaltargetpk/',
  instagram: 'https://www.instagram.com/digitaltarget_pk'
};

export function supportLine() {
  return `${SUPPORT_CONTACT.company}: ${SUPPORT_CONTACT.phone}`;
}

/* ------------------------------------------------------------- lifecycle */

/**
 * What the vendor has decided about a licence, independent of whether it has
 * expired or which computer holds it.
 *
 *   active     sold and running
 *   suspended  temporarily stopped — unpaid instalment, a dispute. Reversible,
 *              and the customer's data is untouched; they get it back the
 *              moment it is resumed.
 *   revoked    finished for good — refunded, charged back, replaced.
 *
 * Suspension exists because "revoke" was doing two jobs that call for
 * different conversations with a customer.
 */
export const LIFECYCLES = [
  { key: 'active',    label: 'Active',    tone: 'ok' },
  { key: 'suspended', label: 'Suspended', tone: 'warn' },
  { key: 'revoked',   label: 'Revoked',   tone: 'bad' }
];

/**
 * Reads a record's lifecycle, tolerating the older shape.
 *
 * Records written before suspension existed carry only `revoked: true|false`.
 * They are still in Firestore and must keep working exactly as they did, so
 * the boolean is honoured whenever the newer field is absent.
 */
export function lifecycleOf(record) {
  if (!record) return 'active';
  const named = String(record.lifecycle || '').toLowerCase();
  const known = LIFECYCLES.some(l => l.key === named);

  // The two fields are written together and should always agree. When they do
  // not — an older tool that knows only the boolean, a hand edit in the
  // console — the stricter one wins. A licence gate that guesses should guess
  // towards stopping, not towards running.
  if (known && named !== 'active') return named;
  if (record.revoked) return known && named !== 'active' ? named : 'revoked';
  return known ? named : 'active';
}

/**
 * The fields to write for a lifecycle change.
 *
 * Both the new field and the old boolean are written, so a copy of the
 * software built before suspension existed still stops on a revoke, and a
 * suspension reads as revoked to it rather than being silently ignored.
 */
export function lifecyclePatch(lifecycle, by) {
  const key = LIFECYCLES.some(l => l.key === lifecycle) ? lifecycle : 'active';
  return {
    lifecycle: key,
    revoked: key !== 'active',
    lifecycleChangedAt: new Date().toISOString(),
    lifecycleChangedBy: String(by || '')
  };
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const a = new Date(todayStr() + 'T00:00:00');
  const b = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/**
 * Decides what a licence record means right now.
 * `machineId` is this computer; a record with no machineId has never been
 * activated and binds to the first machine that uses it.
 */
export function evaluateRecord(record, machineId) {
  if (!record) {
    return { ok: false, status: STATUS.NOT_FOUND,
      message: 'That licence key was not found. Check it was typed exactly as supplied.' };
  }
  const lifecycle = lifecycleOf(record);
  if (lifecycle === 'suspended') {
    return { ok: false, status: STATUS.SUSPENDED, lifecycle,
      message: `License inactive. Please contact ${supportLine()}` };
  }
  if (lifecycle === 'revoked') {
    return { ok: false, status: STATUS.REVOKED, lifecycle,
      message: `License inactive. Please contact ${supportLine()}` };
  }
  if (record.expiresAt) {
    const left = daysUntil(record.expiresAt);
    if (left < 0) {
      return { ok: false, status: STATUS.EXPIRED, expiresAt: record.expiresAt,
        message: `This licence expired on ${record.expiresAt}. Please contact your supplier to renew it.` };
    }
  }
  if (record.machineId && machineId && record.machineId !== machineId) {
    return { ok: false, status: STATUS.WRONG_MACHINE,
      message: 'This licence is already in use on another computer. Contact your supplier to move it.' };
  }

  const left = record.expiresAt ? daysUntil(record.expiresAt) : null;
  return {
    ok: true,
    status: STATUS.ACTIVE,
    lifecycle,
    daysLeft: left,
    expiringSoon: left !== null && left <= 14,
    firstActivation: !record.machineId,
    message: record.expiresAt
      ? `${planByKey(record.plan).label} licence — ${left} day(s) remaining.`
      : `${planByKey(record.plan).label} licence — no expiry.`
  };
}

/** Everything the licence screen shows. */
export function describeRecord(record) {
  if (!record) return null;
  const plan = planByKey(record.plan);
  return {
    key: formatKey(record.key || ''),
    businessName: record.businessName || '',
    ownerName: record.ownerName || '',
    phone: record.phone || '',
    plan: plan.label,
    planKey: plan.key,
    issuedAt: String(record.issuedAt || '').slice(0, 10),
    expiresAt: record.expiresAt || '',
    expires: record.expiresAt || 'Never',
    maxUnits: Number(record.maxUnits) || 0,
    maxUsers: Number(record.maxUsers) || 0,
    units: Number(record.maxUnits) ? String(record.maxUnits) : 'Unlimited',
    users: Number(record.maxUsers) ? String(record.maxUsers) : 'Unlimited',
    features: Array.isArray(record.features) ? record.features : (PLAN_FEATURES[plan.key] || []),
    featureLabels: (Array.isArray(record.features) ? record.features : (PLAN_FEATURES[plan.key] || []))
      .map(k => (FEATURES.find(f => f.key === k) || {}).label || k),
    activatedAt: record.activatedAt || '',
    machineId: record.machineId || '',
    lifecycle: lifecycleOf(record),
    lifecycleLabel: (LIFECYCLES.find(l => l.key === lifecycleOf(record)) || LIFECYCLES[0]).label,
    lifecycleChangedAt: record.lifecycleChangedAt || ''
  };
}

/** A blank record, so the panel and the app agree on the shape. */
export function blankRecord() {
  return {
    key: '', businessName: '', ownerName: '', phone: '', email: '', city: '',
    plan: 'standard', issuedAt: '', expiresAt: '',
    maxUnits: 25, maxUsers: 5, features: PLAN_FEATURES.standard.slice(),
    notes: '', lifecycle: 'active', revoked: false,
    lifecycleChangedAt: '', lifecycleChangedBy: '',
    machineId: '', machineCode: '', activatedAt: '',
    lastSeenAt: '', issuedBy: ''
  };
}
