/**
 * Users, roles and permissions.
 *
 * Offline does not mean unguarded: a receptionist must not be able to wipe the
 * database, void a payment or rewrite settings (requirements 31 and 36).
 */

import { newId } from './ids.js';

export const ROLES = [
  { id: 'admin',        label: 'Admin',        labelUr: 'ایڈمن' },
  { id: 'manager',      label: 'Manager',      labelUr: 'منیجر' },
  { id: 'receptionist', label: 'Receptionist', labelUr: 'استقبالیہ' },
  { id: 'housekeeping', label: 'Housekeeping', labelUr: 'صفائی' },
  { id: 'accountant',   label: 'Accountant',   labelUr: 'اکاؤنٹنٹ' }
];

/** Every guarded action in the product. */
export const PERMISSIONS = [
  'view.dashboard', 'view.reports', 'view.register',
  'guest.create', 'guest.edit', 'guest.archive', 'guest.viewCnic',
  'unit.create', 'unit.edit', 'unit.archive',
  'reservation.create', 'reservation.edit', 'reservation.cancel',
  'stay.checkin', 'stay.checkout', 'stay.checkoutWithBalance', 'stay.changeUnit',
  'folio.add', 'folio.void',
  'payment.create', 'payment.void', 'payment.refund',
  'housekeeping.update', 'maintenance.manage',
  'expense.create', 'expense.void',
  'stock.manage', 'stock.move', 'purchase.create', 'purchase.cancel',
  'day.close', 'day.reopen',
  'settings.manage', 'user.manage', 'backup.manage', 'data.reset'
];

const ALL = new Set(PERMISSIONS);

const ROLE_PERMISSIONS = {
  admin: PERMISSIONS.slice(),

  manager: PERMISSIONS.filter(p => !['data.reset', 'user.manage', 'day.reopen'].includes(p)),

  receptionist: [
    'view.dashboard', 'view.register',
    'guest.create', 'guest.edit', 'guest.viewCnic',
    'reservation.create', 'reservation.edit', 'reservation.cancel',
    'stay.checkin', 'stay.checkout', 'stay.changeUnit',
    'folio.add', 'payment.create',
    'housekeeping.update'
  ],

  housekeeping: ['housekeeping.update', 'maintenance.manage', 'stock.move'],

  accountant: [
    'view.dashboard', 'view.reports', 'view.register',
    'payment.create', 'payment.void', 'payment.refund',
    'expense.create', 'expense.void', 'day.close', 'folio.add', 'folio.void',
    'stock.manage', 'stock.move', 'purchase.create', 'purchase.cancel'
  ]
};

export function permissionsFor(role) {
  return new Set(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.receptionist);
}

export function roleLabel(role) {
  const r = ROLES.find(x => x.id === role);
  return r ? r.label : role;
}

/**
 * Password hashing.
 *
 * This is a device-local product with no network attack surface, but a
 * password must still not sit in the database as plain text — staff reuse
 * passwords, and a stolen laptop should not hand them over.
 *
 * PBKDF2-SHA256 with a per-user salt, through WebCrypto. The iteration count
 * is high enough to make a stolen database tedious to attack and low enough
 * that signing in stays instant on the low-end machines these properties run.
 * A small synchronous fallback covers contexts where crypto.subtle is absent.
 */
const PBKDF2_ITERATIONS = 150000;

export async function hashPassword(password, salt) {
  const text = String(password || '');
  const saltText = String(salt || '');

  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    try {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode(text), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: enc.encode(saltText), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        key, 256);
      return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' +
        Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { /* falls through */ }
  }
  return 'fnv:' + fnv1a(saltText + ':' + text);
}

/**
 * Verifies a password against a stored hash, re-deriving with whatever scheme
 * the hash was written by, so an older record still signs in.
 */
export async function verifyPassword(password, salt, stored) {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    const iterations = Number(parts[1]) || PBKDF2_ITERATIONS;
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
      try {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey('raw', enc.encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: enc.encode(String(salt || '')), iterations, hash: 'SHA-256' }, key, 256);
        const hex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
        return timingSafeEqual('pbkdf2$' + iterations + '$' + hex, stored);
      } catch { return false; }
    }
    return false;
  }
  // Legacy SHA-256 and fallback hashes.
  const legacy = await hashPassword(password, salt);
  if (timingSafeEqual(legacy, stored)) return true;
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(salt || '') + ':' + String(password || '')));
      const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return timingSafeEqual(hex, stored);
    } catch { /* nothing more to try */ }
  }
  return false;
}

/** Constant-time string compare, so a wrong password reveals nothing by timing. */
function timingSafeEqual(a, b) {
  const sa = String(a), sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/** Kept so existing callers and stored PINs keep working. */
export const hashPin = hashPassword;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function newSalt() { return newId('s').slice(-12); }

/** The default the software ships with, which must be changed on first use. */
export const DEFAULT_USERNAME = 'admin';
export const DEFAULT_PASSWORD = '123';

/**
 * Password rules. Deliberately mild: this is a reception desk, not a bank, and
 * a rule staff cannot satisfy just becomes a sticky note on the monitor.
 */
export function checkPassword(password, username) {
  const p = String(password || '');
  // The default is checked first: it is shorter than the minimum, and being
  // told "too short" when the real problem is "that is the printed default"
  // sends people straight back to typing it again.
  if (p === DEFAULT_PASSWORD) return 'That is the password the software ships with. Please choose your own.';
  if (p.length < 4) return 'Password must be at least 4 characters.';
  if (p.length > 64) return 'Password must be 64 characters or fewer.';
  if (username && p.toLowerCase() === String(username).toLowerCase()) return 'The password must not be the same as the username.';
  return null;
}

export class Session {
  constructor(user) {
    this.user = user || null;
    this.permissions = user ? permissionsFor(user.role) : new Set();
  }

  get id() { return this.user ? this.user.id : ''; }
  get name() { return this.user ? this.user.name : 'Guest'; }
  get role() { return this.user ? this.user.role : ''; }

  can(permission) {
    if (!this.user) return false;
    if (!ALL.has(permission)) console.warn('[hms] unknown permission checked:', permission);
    return this.permissions.has(permission);
  }

  /** Throws with a message the UI can show directly. */
  require(permission) {
    if (!this.can(permission)) {
      const err = new Error('Your role (' + roleLabel(this.role) + ') does not allow this action.');
      err.code = 'PERMISSION_DENIED';
      throw err;
    }
  }

  initials() {
    const parts = String(this.name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '—';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
}
