/**
 * Housekeeping and maintenance.
 *
 * Two separate ideas kept separate: `status` is whether a unit can be sold,
 * `hkStatus` is whether it is physically ready. Check-out sets dirty; the
 * housekeeper walks it dirty -> cleaning -> clean; a supervisor may mark it
 * inspected. Reception sees at a glance which units are ready.
 */

import { newId } from '../core/ids.js';
import { makeMaintenance, HK_STATUS } from '../core/schema.js';
import { nowIso, today, inRange } from '../core/dates.js';
import { required, collect } from '../core/validate.js';
import { listUnits, compareUnits } from './units.js';

/** Legal housekeeping transitions. Anything else is refused. */
const HK_FLOW = {
  dirty: ['cleaning', 'clean'],
  cleaning: ['clean', 'dirty'],
  clean: ['inspected', 'dirty'],
  inspected: ['dirty', 'clean']
};

export function nextHkStates(current) {
  return HK_FLOW[current] || ['dirty'];
}

export function board(store, opts) {
  const o = opts || {};
  let units = listUnits(store);
  if (o.hkStatus) units = units.filter(u => u.hkStatus === o.hkStatus);
  if (o.floor) units = units.filter(u => String(u.floor) === String(o.floor));
  return units.slice().sort(compareUnits).map(unit => {
    const stay = store.db.first('reservations', r => r.unitId === unit.id && r.status === 'checked_in');
    const task = store.db.all('housekeeping')
      .filter(t => t.unitId === unit.id && !t.completedAt)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    return {
      unit, task, stay,
      ready: unit.hkStatus === 'clean' || unit.hkStatus === 'inspected',
      occupied: unit.status === 'occupied'
    };
  });
}

export function readyCount(store) {
  return listUnits(store).filter(u => (u.hkStatus === 'clean' || u.hkStatus === 'inspected') && u.status === 'available').length;
}

/**
 * Moves a unit through the cleaning flow and keeps its sellable status in step:
 * a clean, unoccupied unit becomes available again automatically.
 */
export async function setHkStatus(store, unitId, hkStatus, opts) {
  store.session.require('housekeeping.update');
  const o = opts || {};
  const unit = store.db.get('units', unitId);
  if (!unit) throw new Error('Unit not found.');
  if (!HK_STATUS.some(s => s.id === hkStatus)) throw new Error('Unknown housekeeping status.');
  if (unit.hkStatus !== hkStatus && nextHkStates(unit.hkStatus).indexOf(hkStatus) === -1) {
    throw new Error(`A unit that is "${unit.hkStatus}" cannot go straight to "${hkStatus}".`);
  }

  let status = unit.status;
  if (unit.status !== 'occupied' && unit.status !== 'maintenance' && unit.status !== 'blocked') {
    status = (hkStatus === 'clean' || hkStatus === 'inspected') ? 'available' : 'cleaning';
    // A unit held by a booking that starts today reads as reserved, not free.
    if (status === 'available') {
      const held = store.db.where('reservations', 'unitId', unitId)
        .some(r => r.status === 'reserved' && r.checkIn <= today() && r.checkOut > today());
      if (held) status = 'reserved';
    }
  }

  const nextUnit = Object.assign({}, unit, { hkStatus, status });

  await store.write('housekeeping.update', (tx, log) => {
    tx.put('units', nextUnit);

    const open = tx.all('housekeeping')
      .filter(t => t.unitId === unitId && !t.completedAt)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];

    if (hkStatus === 'cleaning') {
      const task = open || { id: newId('hk'), unitId, unitCode: unit.code, reservationId: '', source: 'manual', createdAt: nowIso(), date: today(), completedAt: null, notes: '' };
      tx.put('housekeeping', Object.assign({}, task, {
        status: 'cleaning', startedAt: nowIso(),
        assignedTo: o.assignedTo || store.session.id, notes: o.notes || task.notes
      }));
    } else if (hkStatus === 'clean' || hkStatus === 'inspected') {
      if (open) {
        tx.put('housekeeping', Object.assign({}, open, {
          status: hkStatus, completedAt: nowIso(), completedBy: store.session.id, notes: o.notes || open.notes
        }));
      }
    } else if (hkStatus === 'dirty' && !open) {
      tx.put('housekeeping', {
        id: newId('hk'), unitId, unitCode: unit.code, status: 'dirty', source: 'manual',
        reservationId: '', assignedTo: '', notes: o.notes || '',
        createdAt: nowIso(), startedAt: null, completedAt: null, date: today()
      });
    }

    log('units', unitId, { code: unit.code, from: unit.hkStatus, to: hkStatus });
  });

  return nextUnit;
}

export function tasks(store, opts) {
  const o = opts || {};
  let list = store.db.all('housekeeping');
  if (o.from || o.to) list = list.filter(t => inRange(t.date, o.from, o.to));
  if (o.open) list = list.filter(t => !t.completedAt);
  return list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/* ------------------------------------------------------------- maintenance */

export function validateMaintenance(patch) {
  return collect({
    unitId: required(patch.unitId, 'Unit'),
    reason: required(patch.reason, 'Reason'),
    startDate: required(patch.startDate, 'Start date'),
    range: (patch.expectedEnd && patch.expectedEnd < patch.startDate) ? 'Expected completion cannot be before the start date.' : null
  });
}

/**
 * Puts a unit out of service. A unit with a guest inside, or with bookings
 * inside the maintenance window, is refused — requirement 19 forbids booking a
 * unit under maintenance, and that has to hold for bookings already made.
 */
export async function openMaintenance(store, patch) {
  store.session.require('maintenance.manage');
  const errors = validateMaintenance(patch);
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const unit = store.db.get('units', patch.unitId);
  if (!unit) throw new Error('Unit not found.');
  if (unit.status === 'occupied') throw new Error(`${unit.code} has a guest in it. Check them out before starting maintenance.`);

  const end = patch.expectedEnd || patch.startDate;
  const clash = store.db.where('reservations', 'unitId', patch.unitId).filter(r =>
    (r.status === 'reserved' || r.status === 'checked_in') &&
    r.checkIn <= end && r.checkOut > patch.startDate);
  if (clash.length) {
    const err = new Error(`${unit.code} has ${clash.length} booking(s) during this period. Move or cancel them first.`);
    err.code = 'HAS_BOOKINGS';
    err.conflicts = clash;
    throw err;
  }

  const record = makeMaintenance(Object.assign({}, patch, {
    id: newId('mt'), status: 'open', createdAt: nowIso(), createdBy: store.session.id
  }));

  await store.write('maintenance.open', (tx, log) => {
    tx.put('maintenance', record);
    tx.put('units', Object.assign({}, unit, { status: 'maintenance' }));
    log('maintenance', record.id, { unit: unit.code, reason: record.reason });
  });
  return record;
}

export async function closeMaintenance(store, id, notes) {
  store.session.require('maintenance.manage');
  const record = store.db.get('maintenance', id);
  if (!record) throw new Error('Maintenance record not found.');
  if (record.status === 'done') return record;

  const unit = store.db.get('units', record.unitId);
  const next = Object.assign({}, record, {
    status: 'done', completedAt: nowIso(), completedBy: store.session.id,
    notes: notes !== undefined ? notes : record.notes
  });

  await store.write('maintenance.close', (tx, log) => {
    tx.put('maintenance', next);
    if (unit && unit.status === 'maintenance') {
      const stillOpen = tx.find('maintenance', m => m.unitId === unit.id && m.id !== id && m.status === 'open').length;
      if (!stillOpen) tx.put('units', Object.assign({}, unit, { status: 'cleaning', hkStatus: 'dirty' }));
    }
    log('maintenance', id, { unit: unit ? unit.code : '' });
  });
  return next;
}

export function openMaintenanceList(store) {
  return store.db.all('maintenance').filter(m => m.status === 'open')
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
}

export function maintenanceHistory(store, opts) {
  const o = opts || {};
  let list = store.db.all('maintenance');
  if (o.unitId) list = list.filter(m => m.unitId === o.unitId);
  if (o.from || o.to) list = list.filter(m => inRange(m.startDate, o.from, o.to));
  return list.slice().sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
}
