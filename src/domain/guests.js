/**
 * Guest profiles and history.
 *
 * Requirement 12 asks for no unnecessary duplicates: findMatch() looks a guest
 * up by CNIC, then passport, then phone, so reception reuses the existing
 * profile instead of creating a second one for a returning guest.
 */

import { newId, nextSequence, takenSet } from '../core/ids.js';
import { makeGuest } from '../core/schema.js';
import { nowIso } from '../core/dates.js';
import { required, validCnic, validPhone, validEmail, collect, formatCnic, maskCnic } from '../core/validate.js';
import { toMoney } from '../core/money.js';

export function listGuests(store, opts) {
  const o = opts || {};
  let list = o.includeArchived ? store.db.all('guests') : store.db.live('guests');
  if (o.guestType) list = list.filter(g => g.guestType === o.guestType);
  return list.slice().sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
}

/** Free-text search over name, CNIC, passport and phone. */
export function searchGuests(store, term, limit) {
  const q = String(term || '').trim().toLowerCase();
  if (!q) return listGuests(store).slice(0, limit || 50);
  const digits = q.replace(/\D/g, '');
  const out = [];
  for (const g of store.db.live('guests')) {
    const hay = [g.fullName, g.fullNameUr, g.fatherName, g.city, g.email].join(' ').toLowerCase();
    const ids = [g.cnic, g.passport, g.phone, g.whatsapp, g.code].join(' ').toLowerCase();
    const idDigits = ids.replace(/\D/g, '');
    if (hay.indexOf(q) > -1 || ids.indexOf(q) > -1 || (digits.length >= 4 && idDigits.indexOf(digits) > -1)) {
      out.push(g);
      if (out.length >= (limit || 50)) break;
    }
  }
  return out;
}

/** Exact-identity match, used to avoid creating a duplicate profile. */
export function findMatch(store, patch) {
  const cnic = String(patch.cnic || '').trim();
  if (cnic) {
    const hit = store.db.live('guests').find(g => String(g.cnic || '').trim() === cnic);
    if (hit) return { guest: hit, matchedOn: 'CNIC' };
  }
  const passport = String(patch.passport || '').trim().toUpperCase();
  if (passport) {
    const hit = store.db.live('guests').find(g => String(g.passport || '').trim().toUpperCase() === passport);
    if (hit) return { guest: hit, matchedOn: 'passport' };
  }
  const phone = String(patch.phone || '').replace(/\D/g, '');
  if (phone.length >= 10) {
    const hit = store.db.live('guests').find(g => String(g.phone || '').replace(/\D/g, '') === phone);
    if (hit) return { guest: hit, matchedOn: 'phone' };
  }
  return null;
}

export function validateGuest(store, patch, opts) {
  const requireCnic = opts && opts.requireCnic;
  const idGiven = String(patch.cnic || '').trim() || String(patch.passport || '').trim();
  return collect({
    fullName: required(patch.fullName, 'Full name'),
    cnic: validCnic(patch.cnic) || (requireCnic && !idGiven ? 'A CNIC or passport number is required.' : null),
    phone: validPhone(patch.phone),
    whatsapp: validPhone(patch.whatsapp),
    email: validEmail(patch.email)
  });
}

export async function saveGuest(store, patch, opts) {
  store.session.require(patch.id ? 'guest.edit' : 'guest.create');
  const settings = store.setting('booking');
  const errors = validateGuest(store, patch, { requireCnic: (opts && opts.requireCnic !== undefined) ? opts.requireCnic : settings.requireCnic });
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const existing = patch.id ? store.db.get('guests', patch.id) : null;

  // A new profile that exactly matches an existing one is redirected to it.
  if (!existing && !(opts && opts.allowDuplicate)) {
    const match = findMatch(store, patch);
    if (match) {
      const merged = Object.assign({}, match.guest, stripEmpty(patch), { id: match.guest.id, updatedAt: nowIso() });
      await store.write('guest.update', (tx, log) => {
        tx.put('guests', merged);
        log('guests', merged.id, { matchedOn: match.matchedOn, reused: true });
      });
      return merged;
    }
  }

  const counters = store.counters();
  let record;
  await store.write(existing ? 'guest.update' : 'guest.create', (tx, log) => {
    const code = existing ? existing.code : nextSequence(tx, counters, 'guest', { taken: takenSet(tx.all('guests'), 'code') });
    record = makeGuest(Object.assign({}, existing, patch, {
      id: patch.id || newId('g'),
      code,
      fullName: String(patch.fullName || '').trim(),
      cnic: formatCnic(patch.cnic) || '',
      passport: String(patch.passport || '').trim().toUpperCase(),
      updatedAt: nowIso()
    }));
    tx.put('guests', record);
    log('guests', record.id, { name: record.fullName });
  });
  return record;
}

function stripEmpty(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v !== '' && v !== null && v !== undefined) out[k] = v;
  }
  delete out.id;
  return out;
}

export function guestUsage(store, guestId) {
  const reservations = store.db.where('reservations', 'guestId', guestId);
  return {
    reservations: reservations.length,
    active: reservations.filter(r => r.status === 'reserved' || r.status === 'checked_in').length,
    payments: store.db.where('payments', 'guestId', guestId).length
  };
}

/** Requirement 30: a guest with transactions is archived, never deleted. */
export async function archiveGuest(store, guestId) {
  store.session.require('guest.archive');
  const guest = store.db.get('guests', guestId);
  if (!guest) throw new Error('Guest not found.');
  const usage = guestUsage(store, guestId);
  if (usage.active > 0) throw new Error(`This guest has ${usage.active} active booking(s). Close them first.`);

  const next = Object.assign({}, guest, { archivedAt: nowIso() });
  await store.write('guest.archive', (tx, log) => {
    tx.put('guests', next);
    log('guests', guestId, { name: guest.fullName, reservations: usage.reservations });
  });
  return next;
}

export async function deleteGuest(store, guestId) {
  store.session.require('guest.archive');
  const guest = store.db.get('guests', guestId);
  if (!guest) throw new Error('Guest not found.');
  const usage = guestUsage(store, guestId);
  if (usage.reservations > 0 || usage.payments > 0) {
    const err = new Error('This guest has stay and payment history and cannot be deleted. Archive the profile instead.');
    err.code = 'HAS_HISTORY';
    throw err;
  }
  await store.write('guest.delete', (tx, log) => {
    tx.remove('guests', guestId);
    log('guests', guestId, { name: guest.fullName });
  });
}

export async function restoreGuest(store, guestId) {
  store.session.require('guest.edit');
  const guest = store.db.get('guests', guestId);
  if (!guest) throw new Error('Guest not found.');
  const next = Object.assign({}, guest, { archivedAt: null });
  await store.write('guest.restore', (tx, log) => { tx.put('guests', next); log('guests', guestId, {}); });
  return next;
}

/**
 * Stay history for a guest profile: every booking with what it cost, what was
 * paid against it and what is still outstanding.
 */
export function guestHistory(store, guestId) {
  const reservations = store.db.where('reservations', 'guestId', guestId)
    .slice().sort((a, b) => String(b.checkIn).localeCompare(String(a.checkIn)));

  const payments = store.db.where('payments', 'guestId', guestId).filter(p => !p.voided);

  let totalCharges = 0, totalPaid = 0, nights = 0;
  const stays = reservations.map(r => {
    const paid = payments.filter(p => p.reservationId === r.id)
      .reduce((s, p) => s + (p.kind === 'refund' ? -toMoney(p.amount) : toMoney(p.amount)), 0);
    const unit = store.db.get('units', r.unitId);
    const charges = r.__total !== undefined ? r.__total : 0;
    totalPaid += paid;
    if (r.status !== 'cancelled' && r.status !== 'no_show') nights += Number(r.nights) || 0;
    return { reservation: r, unit, paid, charges };
  });

  return {
    stays,
    payments,
    nights,
    totalPaid,
    totalCharges,
    visits: reservations.filter(r => r.status === 'checked_out').length,
    lastStay: reservations.length ? reservations[0].checkIn : ''
  };
}

/** CNIC is masked unless the signed-in role is allowed to see it. */
export function displayCnic(store, value) {
  if (!value) return '—';
  return store.session.can('guest.viewCnic') ? value : maskCnic(value);
}
