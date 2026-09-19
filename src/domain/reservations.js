/**
 * Reservations, and the double-booking guard.
 *
 * Requirement 9 is the reason this module exists in this shape. The overlap
 * check is not a UI convenience: assertAvailable() is called inside create()
 * and update() themselves, so no caller — a screen, a future import, a future
 * sync module — can write an overlapping booking by skipping a form.
 */

import { newId, nextSequence, takenSet } from '../core/ids.js';
import { makeReservation, RESERVATION_STATUS } from '../core/schema.js';
import { nowIso, today, nightsBetween, rangesOverlap, formatDate, eachDay, addDays } from '../core/dates.js';
import { toMoney } from '../core/money.js';
import { required, validStayDates, collect } from '../core/validate.js';
import { buildRateSnapshot, quote } from './pricing.js';
import { isSellable, capacityOf } from './units.js';

/** Statuses that hold inventory. Cancelled and no-show release the dates. */
export const BLOCKING_STATUSES = RESERVATION_STATUS.filter(s => s.blocksInventory).map(s => s.id);

export function isBlocking(reservation) {
  return reservation && BLOCKING_STATUSES.indexOf(reservation.status) > -1;
}

/* --------------------------------------------------------------- queries */

export function listReservations(store, opts) {
  const o = opts || {};
  let list = store.db.all('reservations').filter(r => !r.archivedAt);
  if (o.status) list = list.filter(r => Array.isArray(o.status) ? o.status.indexOf(r.status) > -1 : r.status === o.status);
  if (o.unitId) list = list.filter(r => r.unitId === o.unitId);
  if (o.guestId) list = list.filter(r => r.guestId === o.guestId);
  if (o.from) list = list.filter(r => r.checkOut > o.from);
  if (o.to) list = list.filter(r => r.checkIn <= o.to);
  return list.slice().sort((a, b) => String(a.checkIn).localeCompare(String(b.checkIn)) || String(a.code).localeCompare(String(b.code)));
}

export function inHouse(store) {
  return listReservations(store, { status: 'checked_in' })
    .sort((a, b) => String(a.checkOut).localeCompare(String(b.checkOut)));
}

export function arrivalsOn(store, date) {
  const d = date || today();
  return listReservations(store).filter(r => r.checkIn === d && (r.status === 'reserved' || r.status === 'checked_in'));
}

export function departuresOn(store, date) {
  const d = date || today();
  return listReservations(store).filter(r => r.checkOut === d && (r.status === 'checked_in' || r.status === 'checked_out'));
}

/** Checked in, past their checkout date, still in the unit. */
export function overdue(store, date) {
  const d = date || today();
  return listReservations(store, { status: 'checked_in' }).filter(r => r.checkOut < d);
}

export function byCode(store, code) {
  return store.db.first('reservations', r => r.code === code || r.registerNo === code) || null;
}

/* ------------------------------------------------- the double-booking guard */

/**
 * Every booking that would collide with [checkIn, checkOut) on `unitId`.
 * The overlap test is half-open, so a same-day turnover is not a conflict.
 */
export function conflictsFor(store, unitId, checkIn, checkOut, excludeId) {
  if (!unitId || !checkIn || !checkOut) return [];
  return store.db.where('reservations', 'unitId', unitId).filter(r =>
    r.id !== excludeId &&
    !r.archivedAt &&
    isBlocking(r) &&
    rangesOverlap(checkIn, checkOut, r.checkIn, r.checkOut)
  );
}

/**
 * Full availability answer for one unit over one date range.
 * `reason` is written to be shown to reception verbatim.
 */
export function checkAvailability(store, unitId, checkIn, checkOut, excludeId) {
  const unit = store.db.get('units', unitId);
  if (!unit) return { available: false, reason: 'That unit no longer exists.', conflicts: [] };

  if (!unit.active || unit.archivedAt) {
    return { available: false, reason: `${unit.code} has been archived and cannot be booked.`, conflicts: [] };
  }
  if (!isSellable(unit)) {
    const why = unit.status === 'maintenance' ? 'is under maintenance' : 'is blocked';
    return { available: false, reason: `${unit.code} ${why} and cannot be booked.`, conflicts: [] };
  }

  const conflicts = conflictsFor(store, unitId, checkIn, checkOut, excludeId);
  if (conflicts.length) {
    return {
      available: false,
      reason: 'Room/Unit is unavailable for the selected dates.',
      conflicts: conflicts.map(r => describeConflict(store, r))
    };
  }
  return { available: true, reason: '', conflicts: [] };
}

export function describeConflict(store, reservation) {
  const guest = store.db.get('guests', reservation.guestId);
  const status = RESERVATION_STATUS.find(s => s.id === reservation.status);
  return {
    id: reservation.id,
    code: reservation.code,
    guestName: guest ? guest.fullName : 'Unknown guest',
    guestPhone: guest ? guest.phone : '',
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    status: reservation.status,
    statusLabel: status ? status.label : reservation.status,
    text: `${reservation.code} · ${guest ? guest.fullName : 'Unknown guest'} · ${formatDate(reservation.checkIn)} → ${formatDate(reservation.checkOut)} · ${status ? status.label : reservation.status}`
  };
}

/** Throws a DOUBLE_BOOKING error carrying the conflicting bookings. */
export function assertAvailable(store, unitId, checkIn, checkOut, excludeId) {
  const result = checkAvailability(store, unitId, checkIn, checkOut, excludeId);
  if (!result.available) {
    const err = new Error(result.reason);
    err.code = result.conflicts.length ? 'DOUBLE_BOOKING' : 'UNIT_UNAVAILABLE';
    err.conflicts = result.conflicts;
    throw err;
  }
}

/** Units that are free for the whole range — what the booking form offers. */
export function availableUnits(store, checkIn, checkOut, opts) {
  const o = opts || {};
  return store.db.live('units')
    .filter(u => isSellable(u))
    .filter(u => !o.unitTypeId || u.unitTypeId === o.unitTypeId)
    .filter(u => {
      if (!checkIn || !checkOut) return true;
      return conflictsFor(store, u.id, checkIn, checkOut, o.excludeId).length === 0;
    })
    .filter(u => {
      if (!o.adults && !o.children) return true;
      const cap = capacityOf(store, u);
      return cap.total >= (Number(o.adults) || 0) + (Number(o.children) || 0);
    });
}

/**
 * Day-by-day status for the availability calendar (requirement 10).
 * Returns one row per unit with a cell per date.
 */
export function availabilityGrid(store, from, to, opts) {
  const o = opts || {};
  const dates = eachDay(from, to, 120);
  let units = store.db.live('units');
  if (o.unitTypeId) units = units.filter(u => u.unitTypeId === o.unitTypeId);
  if (o.unitId) units = units.filter(u => u.id === o.unitId);
  units = units.slice().sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));

  const blocking = store.db.all('reservations').filter(r => !r.archivedAt && isBlocking(r) && r.checkOut > from && r.checkIn <= to);
  const byUnit = new Map();
  blocking.forEach(r => {
    if (!byUnit.has(r.unitId)) byUnit.set(r.unitId, []);
    byUnit.get(r.unitId).push(r);
  });

  const maintenance = store.db.all('maintenance').filter(m => m.status === 'open');
  const maintByUnit = new Map();
  maintenance.forEach(m => {
    if (!maintByUnit.has(m.unitId)) maintByUnit.set(m.unitId, []);
    maintByUnit.get(m.unitId).push(m);
  });

  const rows = units.map(unit => {
    const bookings = byUnit.get(unit.id) || [];
    const blocks = maintByUnit.get(unit.id) || [];
    const cells = dates.map(date => {
      const next = addDays(date, 1);
      const hit = bookings.find(r => rangesOverlap(date, next, r.checkIn, r.checkOut));
      if (hit) {
        const guest = store.db.get('guests', hit.guestId);
        return {
          date,
          state: hit.status === 'checked_in' ? 'occupied' : 'reserved',
          reservationId: hit.id,
          label: guest ? guest.fullName : hit.code,
          isStart: hit.checkIn === date,
          isEnd: addDays(hit.checkOut, -1) === date
        };
      }
      const block = blocks.find(m => rangesOverlap(date, next, m.startDate, m.expectedEnd || addDays(m.startDate, 1)));
      if (block) return { date, state: 'maintenance', label: block.reason || 'Maintenance' };
      if (unit.status === 'blocked') return { date, state: 'blocked', label: 'Blocked' };
      if (unit.status === 'maintenance') return { date, state: 'maintenance', label: 'Maintenance' };
      return { date, state: 'available', label: '' };
    });
    const sold = cells.filter(c => c.state === 'occupied' || c.state === 'reserved').length;
    return { unit, cells, sold, free: cells.length - sold };
  });

  return { dates, rows };
}

/* ----------------------------------------------------------------- writes */

export function validateReservation(store, patch) {
  return collect({
    guestId: required(patch.guestId, 'Guest'),
    unitId: required(patch.unitId, 'Unit'),
    dates: validStayDates(patch.checkIn, patch.checkOut),
    adults: (Number(patch.adults) || 0) < 1 ? 'At least one adult is required.' : null
  });
}

/**
 * Creates a booking. The availability assertion runs here, not in the UI, and
 * again inside the transaction against the committed data — so two bookings
 * saved in the same instant still cannot both take the unit.
 */
export async function createReservation(store, patch) {
  store.session.require('reservation.create');

  const errors = validateReservation(store, patch);
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const unit = store.db.get('units', patch.unitId);
  if (!unit) throw new Error('That unit no longer exists.');

  assertAvailable(store, patch.unitId, patch.checkIn, patch.checkOut, null);

  const cap = capacityOf(store, unit);
  const people = (Number(patch.adults) || 0) + (Number(patch.children) || 0);
  if (cap.total > 0 && people > cap.total && !patch.allowOvercapacity) {
    const err = new Error(`${unit.code} holds ${cap.total} guest(s); you entered ${people}. Add an extra bed or choose a larger unit.`);
    err.code = 'OVER_CAPACITY';
    throw err;
  }

  const snapshot = buildRateSnapshot(store, unit, patch.checkIn, patch.checkOut, patch.rate);
  const counters = store.counters();
  let record;

  await store.write('reservation.create', (tx, log) => {
    // Re-check against committed state inside the transaction.
    const late = tx.find('reservations', r =>
      r.unitId === patch.unitId && !r.archivedAt && isBlocking(r) &&
      rangesOverlap(patch.checkIn, patch.checkOut, r.checkIn, r.checkOut));
    if (late.length) {
      const err = new Error('Room/Unit is unavailable for the selected dates.');
      err.code = 'DOUBLE_BOOKING';
      err.conflicts = late.map(r => describeConflict(store, r));
      throw err;
    }

    const code = nextSequence(tx, counters, 'reservation', { taken: takenSet(tx.all('reservations'), 'code') });
    const registerNo = nextSequence(tx, counters, 'register', { taken: takenSet(tx.all('reservations'), 'registerNo') });

    record = makeReservation(Object.assign({}, patch, {
      id: newId('r'),
      code, registerNo,
      unitTypeId: unit.unitTypeId,
      nights: nightsBetween(patch.checkIn, patch.checkOut),
      rate: snapshot.base,
      rateSnapshot: snapshot,
      discount: toMoney(patch.discount),
      extraBedCharge: toMoney(patch.extraBedCharge !== undefined ? patch.extraBedCharge : snapshot.extraBed),
      extraPersonCharge: toMoney(patch.extraPersonCharge),
      extraBeds: Number(patch.extraBeds) || 0,
      adults: Number(patch.adults) || 1,
      children: Number(patch.children) || 0,
      status: patch.status || 'reserved',
      companions: Array.isArray(patch.companions) ? patch.companions.filter(c => c && c.name) : [],
      createdAt: nowIso(),
      createdBy: store.session.id
    }));
    tx.put('reservations', record);

    // Holding a future date does not change today's board; a stay that starts
    // today marks the unit reserved so the board reads correctly.
    if (record.status === 'reserved' && record.checkIn <= today() && unit.status === 'available') {
      tx.put('units', Object.assign({}, unit, { status: 'reserved' }));
    }

    log('reservations', record.id, { code, unit: unit.code, from: record.checkIn, to: record.checkOut });
  });

  return record;
}

/** Edits a booking. Dates or unit changing re-runs the availability guard. */
export async function updateReservation(store, id, patch) {
  store.session.require('reservation.edit');
  const existing = store.db.get('reservations', id);
  if (!existing) throw new Error('Booking not found.');
  if (existing.status === 'checked_out') throw new Error('A completed stay cannot be edited. Add a folio charge or a payment instead.');
  if (existing.status === 'cancelled') throw new Error('A cancelled booking cannot be edited.');

  const next = Object.assign({}, existing, patch);
  const errors = validateReservation(store, next);
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const datesChanged = next.checkIn !== existing.checkIn || next.checkOut !== existing.checkOut;
  const unitChanged = next.unitId !== existing.unitId;
  if (datesChanged || unitChanged) assertAvailable(store, next.unitId, next.checkIn, next.checkOut, id);

  const unit = store.db.get('units', next.unitId);

  // The frozen rate stays frozen unless the stay itself moved or reception
  // deliberately re-quoted. Requirement 20.
  let snapshot = existing.rateSnapshot;
  if (datesChanged || unitChanged || patch.rate !== undefined) {
    snapshot = buildRateSnapshot(store, unit, next.checkIn, next.checkOut,
      patch.rate !== undefined ? patch.rate : (existing.rateSnapshot ? existing.rateSnapshot.base : existing.rate));
  }

  const record = Object.assign({}, next, {
    nights: nightsBetween(next.checkIn, next.checkOut),
    unitTypeId: unit ? unit.unitTypeId : next.unitTypeId,
    rateSnapshot: snapshot,
    rate: snapshot ? snapshot.base : next.rate,
    discount: toMoney(next.discount),
    updatedAt: nowIso()
  });

  await store.write('reservation.update', (tx, log) => {
    tx.put('reservations', record);
    if (unitChanged) {
      const oldUnit = tx.get('units', existing.unitId);
      if (oldUnit && oldUnit.status !== 'occupied') tx.put('units', Object.assign({}, oldUnit, { status: 'available' }));
      if (unit && existing.status === 'checked_in') tx.put('units', Object.assign({}, unit, { status: 'occupied' }));
    }
    log('reservations', id, { code: existing.code, datesChanged, unitChanged });
  });
  return record;
}

export async function cancelReservation(store, id, reason) {
  store.session.require('reservation.cancel');
  const existing = store.db.get('reservations', id);
  if (!existing) throw new Error('Booking not found.');
  if (existing.status === 'checked_in') throw new Error('This guest is already checked in. Check them out instead of cancelling.');
  if (existing.status === 'checked_out') throw new Error('A completed stay cannot be cancelled.');

  const record = Object.assign({}, existing, {
    status: 'cancelled', cancelledAt: nowIso(), cancelReason: String(reason || ''), cancelledBy: store.session.id
  });

  await store.write('reservation.cancel', (tx, log) => {
    tx.put('reservations', record);
    releaseUnitIfIdle(tx, store, existing.unitId, id);
    log('reservations', id, { code: existing.code, reason: record.cancelReason });
  });
  return record;
}

export async function markNoShow(store, id) {
  store.session.require('reservation.cancel');
  const existing = store.db.get('reservations', id);
  if (!existing) throw new Error('Booking not found.');
  if (existing.status !== 'reserved') throw new Error('Only a booking still waiting to arrive can be marked no-show.');

  const record = Object.assign({}, existing, { status: 'no_show', cancelledAt: nowIso(), cancelReason: 'No-show' });
  await store.write('reservation.noShow', (tx, log) => {
    tx.put('reservations', record);
    releaseUnitIfIdle(tx, store, existing.unitId, id);
    log('reservations', id, { code: existing.code });
  });
  return record;
}

/** Frees a unit only when nothing else is holding it today. */
export function releaseUnitIfIdle(tx, store, unitId, excludeReservationId) {
  const unit = tx.get('units', unitId);
  if (!unit || unit.status === 'maintenance' || unit.status === 'blocked') return;
  const d = today();
  const stillHeld = tx.find('reservations', r =>
    r.id !== excludeReservationId && r.unitId === unitId && !r.archivedAt && isBlocking(r) &&
    r.checkIn <= d && r.checkOut > d);
  if (stillHeld.length) return;
  if (unit.status === 'occupied') return;   // an actual guest is inside
  tx.put('units', Object.assign({}, unit, { status: unit.hkStatus === 'dirty' ? 'cleaning' : 'available' }));
}

/** Live quote for an existing booking — used by folio, checkout and print. */
export function quoteFor(store, reservation) {
  return quote(store, {
    unit: store.db.get('units', reservation.unitId),
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    rateSnapshot: reservation.rateSnapshot,
    rate: reservation.rate,
    extraBeds: reservation.extraBeds,
    extraBedCharge: reservation.extraBedCharge,
    extraPersonCharge: reservation.extraPersonCharge,
    discount: reservation.discount,
    discountType: reservation.discountType,
    advance: 0
  });
}
