/**
 * Pricing.
 *
 * The one inviolable rule (requirement 20/30): a reservation freezes its rate
 * the moment it is created. Changing a unit's rate tomorrow must not alter a
 * booking made today, and re-opening an old invoice must show the old numbers.
 * Every function here therefore reads from a *snapshot* when one exists.
 */

import { toMoney, mul, percent, clampPositive } from '../core/money.js';
import { nightsList, isWeekend } from '../core/dates.js';

/** The rate card in force for a unit right now — used only when quoting. */
export function currentRates(store, unit) {
  const type = unit && unit.unitTypeId ? store.db.get('unitTypes', unit.unitTypeId) : null;
  const pick = (a, b, c) => (a !== undefined && a !== null && a !== '' && Number(a) > 0) ? toMoney(a)
             : (b !== undefined && b !== null && b !== '' && Number(b) > 0) ? toMoney(b) : toMoney(c || 0);
  return {
    base: pick(unit && unit.baseRate, type && type.defaultRate, 0),
    weekend: pick(unit && unit.weekendRate, type && type.weekendRate, 0),
    extraPerson: pick(unit && unit.extraPersonCharge, type && type.extraPersonCharge, 0),
    extraBed: pick(unit && unit.extraBedCharge, type && type.extraBedCharge, 0)
  };
}

/**
 * Builds the immutable rate snapshot stored on a reservation.
 * `override` lets reception quote a custom nightly rate; it still gets frozen.
 */
export function buildRateSnapshot(store, unit, checkIn, checkOut, override) {
  const rates = currentRates(store, unit);
  const weekendDays = store.setting('booking').weekendDays || [0, 6];
  const base = (override !== undefined && override !== null && override !== '') ? toMoney(override) : rates.base;
  const useWeekend = rates.weekend > 0 && (override === undefined || override === null || override === '');

  const nights = nightsList(checkIn, checkOut).map(date => ({
    date,
    weekend: isWeekend(date, weekendDays),
    rate: (useWeekend && isWeekend(date, weekendDays)) ? rates.weekend : base
  }));

  return {
    base,
    weekendRate: useWeekend ? rates.weekend : 0,
    extraPerson: rates.extraPerson,
    extraBed: rates.extraBed,
    custom: override !== undefined && override !== null && override !== '',
    nights,
    frozenAt: new Date().toISOString()
  };
}

/** Room charge for a reservation, always from its own frozen snapshot. */
export function roomCharge(reservation) {
  const snap = reservation && reservation.rateSnapshot;
  if (snap && Array.isArray(snap.nights) && snap.nights.length) {
    return snap.nights.reduce((sum, n) => sum + toMoney(n.rate), 0);
  }
  // Pre-snapshot or hand-entered record: fall back to rate x nights.
  return mul(reservation && reservation.rate, reservation && reservation.nights);
}

/** Average nightly rate actually charged — what ADR reporting uses. */
export function averageNightly(reservation) {
  const nights = Number(reservation && reservation.nights) || 0;
  if (!nights) return 0;
  return Math.round(roomCharge(reservation) / nights);
}

export function discountAmount(reservation, base) {
  const gross = base === undefined ? roomCharge(reservation) : toMoney(base);
  if (!reservation) return 0;
  if (reservation.discountType === 'percent') return percent(gross, reservation.discount);
  return clampPositive(reservation.discount);
}

/** Extra-occupancy charges, also read from the frozen snapshot. */
export function extraCharges(reservation) {
  const snap = (reservation && reservation.rateSnapshot) || {};
  const beds = Number(reservation && reservation.extraBeds) || 0;
  const bedRate = toMoney(reservation && reservation.extraBedCharge ? reservation.extraBedCharge : snap.extraBed);
  const personCharge = toMoney(reservation && reservation.extraPersonCharge);
  const nights = Number(reservation && reservation.nights) || 0;
  return {
    beds: mul(bedRate, beds * nights),
    persons: mul(personCharge, nights)
  };
}

/** Tax settings at the time of quoting; frozen onto the invoice at issue. */
export function taxConfig(store) {
  const p = store.property;
  return {
    enabled: !!p.taxEnabled,
    name: p.taxName || 'Tax',
    percent: Number(p.taxPercent) || 0,
    inclusive: !!p.taxInclusive
  };
}

/**
 * A quote for a not-yet-saved booking — this is what the live bill rail on the
 * check-in screen renders.
 */
export function quote(store, opts) {
  const snapshot = opts.rateSnapshot || buildRateSnapshot(store, opts.unit, opts.checkIn, opts.checkOut, opts.rate);
  const nights = snapshot.nights.length;
  const room = snapshot.nights.reduce((s, n) => s + toMoney(n.rate), 0);
  const extraBeds = mul(toMoney(opts.extraBedCharge !== undefined ? opts.extraBedCharge : snapshot.extraBed), (Number(opts.extraBeds) || 0) * nights);
  const extraPersons = mul(toMoney(opts.extraPersonCharge || 0), nights);
  const gross = room + extraBeds + extraPersons;
  const discount = opts.discountType === 'percent' ? percent(gross, opts.discount) : clampPositive(opts.discount);
  const net = Math.max(0, gross - discount);
  const tax = taxConfig(store);
  const taxAmount = tax.enabled ? (tax.inclusive ? 0 : percent(net, tax.percent)) : 0;
  const total = net + taxAmount;
  const advance = clampPositive(opts.advance);
  return {
    snapshot, nights, room, extraBeds, extraPersons, gross,
    discount, net, tax, taxAmount, total, advance,
    balance: total - advance
  };
}
