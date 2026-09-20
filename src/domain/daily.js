/**
 * Daily closing.
 *
 * Closing a day writes a snapshot of that day's figures and locks it. After
 * that, receipts and expenses dated inside it cannot be voided — requirement 24
 * says a closed day's totals must not change quietly underneath the owner.
 */

import { newId } from '../core/ids.js';
import { nowIso, today, addDays, formatDate } from '../core/dates.js';
import { toMoney } from '../core/money.js';
import { PAYMENT_METHODS } from '../core/schema.js';
import { listPayments, collectionBreakdown } from './payments.js';
import { listExpenses } from './expenses.js';
import { arrivalsOn, departuresOn, listReservations } from './reservations.js';
import { billFor } from './folio.js';
import { listUnits } from './units.js';

export function closingFor(store, date) {
  return store.db.first('dayClosings', c => c.date === date) || null;
}

export function isClosed(store, date) {
  const c = closingFor(store, date);
  return !!(c && c.locked);
}

/** Yesterday's closing cash becomes today's opening, unless overridden. */
export function suggestedOpening(store, date) {
  const prev = closingFor(store, addDays(date, -1));
  return prev ? toMoney(prev.closingCash) : 0;
}

/**
 * Live figures for a day. Returns the same shape whether the day is open or
 * closed — a closed day serves its frozen snapshot.
 */
export function dayFigures(store, date, opts) {
  const d = date || today();
  const existing = closingFor(store, d);
  if (existing && existing.locked && !(opts && opts.live)) {
    return Object.assign({}, existing.figures, { date: d, locked: true, closedAt: existing.closedAt, closedBy: existing.closedBy });
  }

  const opening = (opts && opts.openingBalance !== undefined)
    ? toMoney(opts.openingBalance)
    : (existing ? toMoney(existing.openingBalance) : suggestedOpening(store, d));

  const collection = collectionBreakdown(store, d, d);
  const expenses = listExpenses(store, { from: d, to: d });
  const expenseTotal = expenses.reduce((s, e) => s + toMoney(e.amount), 0);
  const expenseCash = expenses.filter(e => e.method === 'cash').reduce((s, e) => s + toMoney(e.amount), 0);

  const byMethod = PAYMENT_METHODS.map(m => ({
    id: m.id, label: m.label,
    received: listPayments(store, { from: d, to: d, method: m.id })
      .filter(p => p.kind !== 'refund').reduce((s, p) => s + toMoney(p.amount), 0),
    refunded: listPayments(store, { from: d, to: d, method: m.id })
      .filter(p => p.kind === 'refund').reduce((s, p) => s + toMoney(p.amount), 0)
  }));

  const arrivals = arrivalsOn(store, d);
  const departures = departuresOn(store, d);

  // Revenue earned on the night of `d`, regardless of when it is paid.
  const inHouseThatNight = listReservations(store).filter(r =>
    ['checked_in', 'checked_out'].indexOf(r.status) > -1 && r.checkIn <= d && r.checkOut > d);
  const roomRevenue = inHouseThatNight.reduce((sum, r) => {
    const snap = r.rateSnapshot;
    const night = snap && Array.isArray(snap.nights) ? snap.nights.find(n => n.date === d) : null;
    return sum + toMoney(night ? night.rate : r.rate);
  }, 0);

  const outstandingTotal = listReservations(store, { status: ['checked_in', 'checked_out'] })
    .reduce((sum, r) => sum + Math.max(0, billFor(store, r).balance), 0);

  const cashReceived = (byMethod.find(m => m.id === 'cash') || {}).received || 0;
  const cashRefunded = (byMethod.find(m => m.id === 'cash') || {}).refunded || 0;
  const closingCash = opening + cashReceived - cashRefunded - expenseCash;

  const units = listUnits(store);
  const sellable = units.filter(u => u.status !== 'maintenance' && u.status !== 'blocked').length || units.length;

  return {
    date: d,
    locked: false,
    openingBalance: opening,
    byMethod,
    received: collection.received,
    refunded: collection.refunded,
    netCollection: collection.net,
    expenseTotal,
    expenseCash,
    closingCash,
    roomRevenue,
    outstanding: outstandingTotal,
    arrivals: arrivals.length,
    departures: departures.length,
    occupied: inHouseThatNight.length,
    available: sellable,
    occupancy: sellable ? Math.round(inHouseThatNight.length * 1000 / sellable) / 10 : 0,
    paymentCount: collection.payments.length,
    expenseCount: expenses.length
  };
}

export async function closeDay(store, date, opts) {
  store.session.require('day.close');
  const o = opts || {};
  const d = date || today();
  if (d > today()) throw new Error('A day in the future cannot be closed.');

  const existing = closingFor(store, d);
  if (existing && existing.locked) throw new Error(`${formatDate(d)} is already closed.`);

  const figures = dayFigures(store, d, { live: true, openingBalance: o.openingBalance });

  const record = {
    id: existing ? existing.id : newId('dc'),
    date: d,
    openingBalance: figures.openingBalance,
    closingCash: figures.closingCash,
    figures,
    notes: String(o.notes || ''),
    locked: true,
    closedAt: nowIso(),
    closedBy: store.session.id,
    closedByName: store.session.name
  };

  await store.write('day.close', (tx, log) => {
    tx.put('dayClosings', record);
    log('dayClosings', record.id, { date: d, net: figures.netCollection, cash: figures.closingCash });
  });
  return record;
}

/** Admin-only, and it leaves the original snapshot on the record. */
export async function reopenDay(store, date, reason) {
  store.session.require('day.reopen');
  const existing = closingFor(store, date);
  if (!existing) throw new Error('That day has not been closed.');
  if (!String(reason || '').trim()) throw new Error('A reason is required to reopen a closed day.');

  const next = Object.assign({}, existing, {
    locked: false,
    reopenedAt: nowIso(),
    reopenedBy: store.session.id,
    reopenReason: String(reason).trim(),
    frozenFigures: existing.figures   // the numbers as they stood at closing
  });
  await store.write('day.reopen', (tx, log) => {
    tx.put('dayClosings', next);
    log('dayClosings', existing.id, { date, reason: next.reopenReason });
  });
  return next;
}

export function closingHistory(store, limit) {
  return store.db.all('dayClosings')
    .slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limit || 60);
}
