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

  housekeeping: ['housekeeping.update', 'maintenance.manage'],

  accountant: [
    'view.dashboard', 'view.reports', 'view.register',
    'payment.create', 'payment.void', 'payment.refund',
    'expense.create', 'expense.void', 'day.close', 'folio.add', 'folio.void'
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
 * PIN hashing. This is an offline device-local product with no network attack
 * surface, but a PIN should still not sit in the database as plain text.
 * SHA-256 over PIN + per-user salt, via WebCrypto, with a small synchronous
 * fallback for file:// contexts where crypto.subtle is not exposed.
 */
export async function hashPin(pin, salt) {
  const text = String(salt || '') + ':' + String(pin || '');
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { /* falls through */ }
  }
  return 'fnv:' + fnv1a(text);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function newSalt() { return newId('s').slice(-12); }

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
