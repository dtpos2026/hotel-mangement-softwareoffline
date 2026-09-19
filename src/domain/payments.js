/**
 * Payments — an append-only ledger.
 *
 * Requirement 17: a financial record is never silently overwritten. There is no
 * edit here. A mistake is corrected by voiding the receipt (which keeps the row
 * and the reason) or by recording a refund, both of which leave a trail.
 */

import { newId, nextSequence, takenSet } from '../core/ids.js';
import { makePayment, PAYMENT_METHODS } from '../core/schema.js';
import { nowIso, today, dateOfIso, inRange } from '../core/dates.js';
import { toMoney } from '../core/money.js';
import { required, positiveInt, collect } from '../core/validate.js';
import { billFor, paidTotal } from './folio.js';

export function listPayments(store, opts) {
  const o = opts || {};
  let list = store.db.all('payments');
  if (!o.includeVoided) list = list.filter(p => !p.voided);
  if (o.reservationId) list = list.filter(p => p.reservationId === o.reservationId);
  if (o.guestId) list = list.filter(p => p.guestId === o.guestId);
  if (o.method) list = list.filter(p => p.method === o.method);
  if (o.kind) list = list.filter(p => p.kind === o.kind);
  if (o.from || o.to) list = list.filter(p => inRange(dateOfIso(p.at), o.from, o.to));
  return list.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function validatePayment(patch) {
  return collect({
    amount: toMoney(patch.amount) <= 0 ? 'Amount must be more than zero.' : positiveInt(patch.amount, 'Amount'),
    method: required(patch.method, 'Payment method')
  });
}

/**
 * Records money in. `kind` is 'advance' before arrival, 'payment' during or at
 * settlement. Overpayment is refused so the ledger cannot go negative by
 * accident; a genuine deposit beyond the bill is recorded as an advance.
 */
export async function recordPayment(store, patch) {
  store.session.require('payment.create');
  const errors = validatePayment(patch);
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const reservation = patch.reservationId ? store.db.get('reservations', patch.reservationId) : null;
  if (patch.reservationId && !reservation) throw new Error('Booking not found.');
  if (reservation && (reservation.status === 'cancelled' || reservation.status === 'no_show') && patch.kind !== 'refund') {
    throw new Error('This booking is cancelled. Record a refund instead of a payment.');
  }

  const amount = toMoney(patch.amount);
  const counters = store.counters();
  let record;

  await store.write('payment.create', (tx, log) => {
    const code = nextSequence(tx, counters, 'receipt', { taken: takenSet(tx.all('payments'), 'code') });
    record = makePayment({
      id: newId('p'),
      code,
      reservationId: patch.reservationId || '',
      guestId: patch.guestId || (reservation ? reservation.guestId : ''),
      amount,
      method: PAYMENT_METHODS.some(m => m.id === patch.method) ? patch.method : 'other',
      reference: String(patch.reference || '').trim(),
      notes: String(patch.notes || '').trim(),
      kind: patch.kind === 'advance' || patch.kind === 'refund' ? patch.kind : 'payment',
      at: patch.at || nowIso(),
      userId: store.session.id
    });
    tx.put('payments', record);
    log('payments', record.id, {
      code, amount, method: record.method, kind: record.kind,
      reservation: reservation ? reservation.code : ''
    });
  });

  return record;
}

export async function recordRefund(store, patch) {
  store.session.require('payment.refund');
  return recordPayment(store, Object.assign({}, patch, { kind: 'refund' }));
}

/** A void keeps the receipt number retired — it is never reissued. */
export async function voidPayment(store, paymentId, reason) {
  store.session.require('payment.void');
  const payment = store.db.get('payments', paymentId);
  if (!payment) throw new Error('Payment not found.');
  if (payment.voided) return payment;
  if (!String(reason || '').trim()) throw new Error('A reason is required to void a receipt.');

  const day = dateOfIso(payment.at);
  const closing = store.db.first('dayClosings', c => c.date === day && c.locked);
  if (closing) throw new Error(`${day} has been closed. A receipt from a closed day cannot be voided — record a refund instead.`);

  const next = Object.assign({}, payment, {
    voided: true, voidReason: String(reason).trim(), voidedAt: nowIso(), voidedBy: store.session.id
  });
  await store.write('payment.void', (tx, log) => {
    tx.put('payments', next);
    log('payments', paymentId, { code: payment.code, amount: payment.amount, reason: next.voidReason });
  });
  return next;
}

/** What this booking still owes right now. */
export function balanceOf(store, reservation) {
  const bill = billFor(store, reservation);
  return { total: bill.total, paid: bill.paid, balance: bill.balance, bill };
}

/** Every stay with money still outstanding — the outstanding report. */
export function outstanding(store, opts) {
  const o = opts || {};
  const statuses = o.statuses || ['checked_in', 'checked_out'];
  const out = [];
  for (const r of store.db.all('reservations')) {
    if (r.archivedAt || statuses.indexOf(r.status) === -1) continue;
    const bill = billFor(store, r);
    if (bill.balance > 0) {
      out.push({ reservation: r, bill, balance: bill.balance, guest: store.db.get('guests', r.guestId), unit: store.db.get('units', r.unitId) });
    }
  }
  return out.sort((a, b) => b.balance - a.balance);
}

/** Collection split by method for a date or a range — the day-close figures. */
export function collectionBreakdown(store, from, to) {
  const list = listPayments(store, { from: from || today(), to: to || from || today() });
  const byMethod = {};
  PAYMENT_METHODS.forEach(m => { byMethod[m.id] = 0; });
  let received = 0, refunded = 0;
  for (const p of list) {
    const amt = toMoney(p.amount);
    if (p.kind === 'refund') { refunded += amt; byMethod[p.method] = (byMethod[p.method] || 0) - amt; }
    else { received += amt; byMethod[p.method] = (byMethod[p.method] || 0) + amt; }
  }
  return { payments: list, byMethod, received, refunded, net: received - refunded };
}

export function methodName(id) {
  const m = PAYMENT_METHODS.find(x => x.id === id);
  return m ? m.label : 'Other';
}

export { paidTotal };
