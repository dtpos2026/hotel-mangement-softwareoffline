/**
 * Unit types and units.
 *
 * A "unit" is whatever the property sells a night of: a room, a cottage, an
 * apartment, a villa or a bed. Requirement 6 forbids deleting one that history
 * depends on, so delete() refuses and offers archiving instead.
 */

import { newId } from '../core/ids.js';
import { makeUnit, makeUnitType, UNIT_STATUS, HK_STATUS } from '../core/schema.js';
import { nowIso } from '../core/dates.js';
import { toMoney } from '../core/money.js';
import { required, positiveInt, collect } from '../core/validate.js';

/* ------------------------------------------------------------------ queries */

export function listUnitTypes(store, opts) {
  const all = (opts && opts.includeArchived) ? store.db.all('unitTypes') : store.db.live('unitTypes');
  return all.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function listUnits(store, opts) {
  const o = opts || {};
  let list = o.includeArchived ? store.db.all('units') : store.db.live('units');
  if (o.unitTypeId) list = list.filter(u => u.unitTypeId === o.unitTypeId);
  if (o.floor) list = list.filter(u => String(u.floor) === String(o.floor));
  if (o.status) list = list.filter(u => u.status === o.status);
  if (o.hkStatus) list = list.filter(u => u.hkStatus === o.hkStatus);
  return list.slice().sort(compareUnits);
}

/** "101" before "102" before "1010"; names sort naturally alongside numbers. */
export function compareUnits(a, b) {
  const fa = String(a.floor || ''), fb = String(b.floor || '');
  if (fa !== fb) return fa.localeCompare(fb, undefined, { numeric: true });
  return String(a.code || '').localeCompare(String(b.code || ''), undefined, { numeric: true });
}

export function unitLabel(store, unitId) {
  const u = store.db.get('units', unitId);
  return u ? u.code : '—';
}

export function unitTypeName(store, unitTypeId) {
  const t = store.db.get('unitTypes', unitTypeId);
  return t ? t.name : '—';
}

export function floorsOf(store) {
  const seen = new Set();
  listUnits(store).forEach(u => { if (u.floor) seen.add(String(u.floor)); });
  return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function countByStatus(store) {
  const counts = {};
  UNIT_STATUS.forEach(s => { counts[s.id] = 0; });
  listUnits(store).forEach(u => { counts[u.status] = (counts[u.status] || 0) + 1; });
  return counts;
}

export function countByHkStatus(store) {
  const counts = {};
  HK_STATUS.forEach(s => { counts[s.id] = 0; });
  listUnits(store).forEach(u => { counts[u.hkStatus] = (counts[u.hkStatus] || 0) + 1; });
  return counts;
}

/** A unit is sellable unless it is physically out of service. */
export function isSellable(unit) {
  if (!unit || !unit.active || unit.archivedAt) return false;
  return unit.status !== 'maintenance' && unit.status !== 'blocked';
}

export function capacityOf(store, unit) {
  const type = unit && unit.unitTypeId ? store.db.get('unitTypes', unit.unitTypeId) : null;
  const adults = Number(unit && unit.capacityAdults) || Number(type && type.capacityAdults) || 0;
  const children = Number(unit && unit.capacityChildren) || Number(type && type.capacityChildren) || 0;
  return { adults, children, total: adults + children };
}

/* ------------------------------------------------------------- unit types */

export function validateUnitType(patch) {
  return collect({
    name: required(patch.name, 'Type name'),
    capacityAdults: positiveInt(patch.capacityAdults, 'Adults capacity'),
    capacityChildren: positiveInt(patch.capacityChildren, 'Children capacity'),
    defaultRate: positiveInt(patch.defaultRate, 'Default rate')
  });
}

export async function saveUnitType(store, patch) {
  store.session.require(patch.id ? 'unit.edit' : 'unit.create');
  const errors = validateUnitType(patch);
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const existing = patch.id ? store.db.get('unitTypes', patch.id) : null;
  const record = makeUnitType(Object.assign({}, existing, patch, {
    id: patch.id || newId('ut'),
    capacityAdults: Number(patch.capacityAdults) || 0,
    capacityChildren: Number(patch.capacityChildren) || 0,
    defaultRate: toMoney(patch.defaultRate),
    weekendRate: toMoney(patch.weekendRate),
    extraPersonCharge: toMoney(patch.extraPersonCharge),
    extraBedCharge: toMoney(patch.extraBedCharge),
    amenities: Array.isArray(patch.amenities) ? patch.amenities : (existing ? existing.amenities : [])
  }));

  await store.write(existing ? 'unitType.update' : 'unitType.create', (tx, log) => {
    tx.put('unitTypes', record);
    log('unitTypes', record.id, { name: record.name });
  });
  return record;
}

export function unitTypeUsage(store, unitTypeId) {
  return {
    units: store.db.find('units', u => u.unitTypeId === unitTypeId && !u.archivedAt).length,
    reservations: store.db.find('reservations', r => r.unitTypeId === unitTypeId).length
  };
}

export async function archiveUnitType(store, id) {
  store.session.require('unit.archive');
  const record = store.db.get('unitTypes', id);
  if (!record) throw new Error('Unit type not found.');
  const usage = unitTypeUsage(store, id);
  if (usage.units > 0) throw new Error(`${usage.units} unit(s) still use this type. Move them to another type first.`);

  const next = Object.assign({}, record, { active: false, archivedAt: nowIso() });
  await store.write('unitType.archive', (tx, log) => {
    tx.put('unitTypes', next);
    log('unitTypes', id, { name: record.name });
  });
  return next;
}

/* ------------------------------------------------------------------ units */

export function validateUnit(store, patch) {
  const duplicate = store.db.find('units', u =>
    u.id !== patch.id && !u.archivedAt &&
    String(u.code || '').trim().toLowerCase() === String(patch.code || '').trim().toLowerCase()
  ).length > 0;

  return collect({
    code: required(patch.code, 'Unit number') || (duplicate ? 'Another unit already uses this number.' : null),
    unitTypeId: required(patch.unitTypeId, 'Unit type'),
    capacityAdults: positiveInt(patch.capacityAdults, 'Adults capacity'),
    capacityChildren: positiveInt(patch.capacityChildren, 'Children capacity'),
    baseRate: positiveInt(patch.baseRate, 'Base rate')
  });
}

export async function saveUnit(store, patch) {
  store.session.require(patch.id ? 'unit.edit' : 'unit.create');
  const errors = validateUnit(store, patch);
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const existing = patch.id ? store.db.get('units', patch.id) : null;

  // A unit that is occupied right now cannot be silently switched to another
  // status by an edit form — that would desynchronise the board from reality.
  let status = patch.status || (existing ? existing.status : 'available');
  if (existing && existing.status === 'occupied' && status !== 'occupied') {
    const active = store.db.find('reservations', r => r.unitId === existing.id && r.status === 'checked_in').length;
    if (active > 0) status = 'occupied';
  }

  const record = makeUnit(Object.assign({}, existing, patch, {
    id: patch.id || newId('un'),
    code: String(patch.code).trim(),
    status,
    capacityAdults: Number(patch.capacityAdults) || 0,
    capacityChildren: Number(patch.capacityChildren) || 0,
    baseRate: toMoney(patch.baseRate),
    weekendRate: toMoney(patch.weekendRate),
    extraPersonCharge: toMoney(patch.extraPersonCharge),
    extraBedCharge: toMoney(patch.extraBedCharge),
    amenities: Array.isArray(patch.amenities) ? patch.amenities : (existing ? existing.amenities : [])
  }));

  await store.write(existing ? 'unit.update' : 'unit.create', (tx, log) => {
    tx.put('units', record);
    log('units', record.id, { code: record.code });
  });
  return record;
}

/** History that would be orphaned by a delete. */
export function unitUsage(store, unitId) {
  const reservations = store.db.where('reservations', 'unitId', unitId);
  return {
    reservations: reservations.length,
    active: reservations.filter(r => r.status === 'reserved' || r.status === 'checked_in').length
  };
}

export function canDeleteUnit(store, unitId) {
  return unitUsage(store, unitId).reservations === 0;
}

/**
 * Deletion is allowed only for a unit that was never sold. Anything with
 * history is archived, so reports and old invoices keep resolving its name.
 */
export async function deleteUnit(store, unitId) {
  store.session.require('unit.archive');
  const unit = store.db.get('units', unitId);
  if (!unit) throw new Error('Unit not found.');
  const usage = unitUsage(store, unitId);
  if (usage.reservations > 0) {
    const err = new Error(`This unit has ${usage.reservations} booking(s) in its history and cannot be deleted. Archive it instead — it will disappear from the board but stay on old records.`);
    err.code = 'HAS_HISTORY';
    throw err;
  }
  await store.write('unit.delete', (tx, log) => {
    tx.remove('units', unitId);
    log('units', unitId, { code: unit.code });
  });
}

export async function archiveUnit(store, unitId) {
  store.session.require('unit.archive');
  const unit = store.db.get('units', unitId);
  if (!unit) throw new Error('Unit not found.');
  const usage = unitUsage(store, unitId);
  if (usage.active > 0) throw new Error(`This unit has ${usage.active} active booking(s). Check out or cancel them before archiving.`);

  const next = Object.assign({}, unit, { active: false, archivedAt: nowIso(), status: 'blocked' });
  await store.write('unit.archive', (tx, log) => {
    tx.put('units', next);
    log('units', unitId, { code: unit.code });
  });
  return next;
}

export async function restoreUnit(store, unitId) {
  store.session.require('unit.edit');
  const unit = store.db.get('units', unitId);
  if (!unit) throw new Error('Unit not found.');
  const next = Object.assign({}, unit, { active: true, archivedAt: null, status: 'available' });
  await store.write('unit.restore', (tx, log) => {
    tx.put('units', next);
    log('units', unitId, { code: unit.code });
  });
  return next;
}

/** Direct status change from the board (block / unblock / send to cleaning). */
export async function setUnitStatus(store, unitId, status, note) {
  const unit = store.db.get('units', unitId);
  if (!unit) throw new Error('Unit not found.');
  if (!UNIT_STATUS.some(s => s.id === status)) throw new Error('Unknown status: ' + status);

  if (unit.status === 'occupied' && status !== 'occupied') {
    const active = store.db.find('reservations', r => r.unitId === unitId && r.status === 'checked_in').length;
    if (active > 0) throw new Error('A guest is still checked into this unit. Check them out first.');
  }
  if (status === 'occupied') throw new Error('Occupied is set by check-in, not by hand.');

  store.session.require(status === 'maintenance' || status === 'blocked' ? 'maintenance.manage' : 'housekeeping.update');

  const next = Object.assign({}, unit, {
    status,
    hkStatus: status === 'cleaning' ? 'cleaning' : unit.hkStatus,
    notes: note !== undefined ? note : unit.notes
  });
  await store.write('unit.status', (tx, log) => {
    tx.put('units', next);
    log('units', unitId, { from: unit.status, to: status });
  });
  return next;
}
