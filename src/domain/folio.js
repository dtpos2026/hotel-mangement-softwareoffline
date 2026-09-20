/**
 * Folio and bill computation.
 *
 * Room charges are derived from the reservation's frozen rate snapshot rather
 * than stored as rows, so they can never drift out of step with the nights.
 * Everything else — food, laundry, extra bed, transport, custom charges — is a
 * stored folioLine. A voided line stays in the table with its reason; it is
 * never edited away (requirement 30).
 */

import { newId } from '../core/ids.js';
import { makeFolioLine, CHARGE_CATEGORIES } from '../core/schema.js';
import { nowIso, today, formatDate } from '../core/dates.js';
import { toMoney, mul, percent, clampPositive } from '../core/money.js';
import { roomCharge, taxConfig } from './pricing.js';
import { required, positiveInt, collect } from '../core/validate.js';

export function linesFor(store, reservationId, opts) {
  const all = store.db.where('folioLines', 'reservationId', reservationId);
  const list = (opts && opts.includeVoided) ? all : all.filter(l => !l.voided);
  return list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function paymentsFor(store, reservationId, opts) {
  const all = store.db.where('payments', 'reservationId', reservationId);
  const list = (opts && opts.includeVoided) ? all : all.filter(p => !p.voided);
  return list.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Signed total of payments: refunds subtract. */
export function paidTotal(payments) {
  return payments.reduce((sum, p) => sum + (p.kind === 'refund' ? -toMoney(p.amount) : toMoney(p.amount)), 0);
}

/**
 * The complete bill for a reservation.
 *
 * If the stay has been invoiced, the frozen invoice is returned instead of a
 * recomputation — that is what makes an old invoice immune to today's prices.
 */
export function billFor(store, reservation, opts) {
  const o = opts || {};
  if (!reservation) return emptyBill(store);

  const invoice = !o.live && reservation.invoiceNo
    ? store.db.first('invoices', i => i.no === reservation.invoiceNo)
    : null;

  const payments = paymentsFor(store, reservation.id);
  const paid = paidTotal(payments);

  if (invoice) {
    return Object.assign({}, invoice.bill, {
      frozen: true,
      invoiceNo: invoice.no,
      issuedAt: invoice.issuedAt,
      payments,
      paid,
      balance: invoice.bill.total - paid
    });
  }

  const unit = store.db.get('units', reservation.unitId);
  const room = roomCharge(reservation);
  const nights = Number(reservation.nights) || 0;

  const roomLines = [{
    id: 'room',
    date: reservation.checkIn,
    category: 'room',
    description: `${unit ? unit.code : 'Unit'} — ${nights} night${nights === 1 ? '' : 's'}`,
    qty: nights,
    rate: nights ? Math.round(room / nights) : room,
    amount: room,
    system: true
  }];

  const beds = Number(reservation.extraBeds) || 0;
  if (beds > 0) {
    const rate = toMoney(reservation.extraBedCharge);
    roomLines.push({
      id: 'extrabed', date: reservation.checkIn, category: 'extrabed',
      description: `Extra bed × ${beds}`, qty: beds * nights, rate,
      amount: mul(rate, beds * nights), system: true
    });
  }
  const extraPerson = toMoney(reservation.extraPersonCharge);
  if (extraPerson > 0) {
    roomLines.push({
      id: 'extraperson', date: reservation.checkIn, category: 'service',
      description: 'Extra person charge', qty: nights, rate: extraPerson,
      amount: mul(extraPerson, nights), system: true
    });
  }

  const extras = linesFor(store, reservation.id);
  const lines = roomLines.concat(extras.map(l => ({
    id: l.id, date: l.date, category: l.category, description: l.description,
    qty: l.qty, rate: l.rate, amount: toMoney(l.amount), system: false
  })));

  const gross = lines.reduce((s, l) => s + toMoney(l.amount), 0);
  const discount = reservation.discountType === 'percent'
    ? percent(gross, reservation.discount)
    : clampPositive(reservation.discount);
  const net = Math.max(0, gross - discount);
  const tax = taxConfig(store);
  const taxAmount = tax.enabled && !tax.inclusive ? percent(net, tax.percent) : 0;
  const total = net + taxAmount;

  return {
    frozen: false,
    invoiceNo: reservation.invoiceNo || '',
    issuedAt: '',
    reservationId: reservation.id,
    lines, roomCharge: room, gross, discount,
    discountLabel: reservation.discountType === 'percent' ? `Discount ${Number(reservation.discount) || 0}%` : 'Discount',
    net, tax, taxAmount, total,
    payments, paid,
    balance: total - paid,
    nights
  };
}

function emptyBill(store) {
  return {
    frozen: false, invoiceNo: '', issuedAt: '', reservationId: '',
    lines: [], roomCharge: 0, gross: 0, discount: 0, discountLabel: 'Discount',
    net: 0, tax: taxConfig(store), taxAmount: 0, total: 0,
    payments: [], paid: 0, balance: 0, nights: 0
  };
}

/* ------------------------------------------------------------------ writes */

export function validateCharge(patch) {
  return collect({
    description: required(patch.description, 'Description'),
    qty: (Number(patch.qty) || 0) <= 0 ? 'Quantity must be more than zero.' : null,
    rate: positiveInt(patch.rate, 'Rate')
  });
}

export async function addCharge(store, reservationId, patch) {
  store.session.require('folio.add');
  const reservation = store.db.get('reservations', reservationId);
  if (!reservation) throw new Error('Booking not found.');
  if (reservation.status === 'cancelled' || reservation.status === 'no_show') {
    throw new Error('Charges cannot be added to a cancelled booking.');
  }
  if (reservation.invoiceNo) {
    throw new Error('This stay has been invoiced. Re-open the invoice before adding charges.');
  }

  const errors = validateCharge(patch);
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const qty = Number(patch.qty) || 1;
  const rate = toMoney(patch.rate);
  const record = makeFolioLine({
    id: newId('fl'),
    reservationId,
    date: patch.date || today(),
    category: CHARGE_CATEGORIES.some(c => c.id === patch.category) ? patch.category : 'custom',
    description: String(patch.description).trim(),
    qty, rate,
    amount: mul(rate, qty),
    addedBy: store.session.id,
    createdAt: nowIso()
  });

  await store.write('folio.add', (tx, log) => {
    tx.put('folioLines', record);
    log('folioLines', record.id, { reservation: reservation.code, description: record.description, amount: record.amount });
  });
  return record;
}

/** Voiding keeps the row and its history; nothing is deleted. */
export async function voidCharge(store, lineId, reason) {
  store.session.require('folio.void');
  const line = store.db.get('folioLines', lineId);
  if (!line) throw new Error('Charge not found.');
  if (line.voided) return line;

  const reservation = store.db.get('reservations', line.reservationId);
  if (reservation && reservation.invoiceNo) throw new Error('This stay has been invoiced and its charges are locked.');

  const next = Object.assign({}, line, {
    voided: true, voidReason: String(reason || ''), voidedAt: nowIso(), voidedBy: store.session.id
  });
  await store.write('folio.void', (tx, log) => {
    tx.put('folioLines', next);
    log('folioLines', lineId, { reason: next.voidReason, amount: line.amount });
  });
  return next;
}

export function chargeCategoryLabel(id) {
  const c = CHARGE_CATEGORIES.find(x => x.id === id);
  return c ? c.label : 'Charge';
}

/** Folio summary grouped by category — used on the A4 invoice. */
export function groupByCategory(bill) {
  const groups = new Map();
  for (const line of bill.lines) {
    const key = line.category || 'custom';
    if (!groups.has(key)) groups.set(key, { category: key, label: chargeCategoryLabel(key), amount: 0, count: 0 });
    const g = groups.get(key);
    g.amount += toMoney(line.amount);
    g.count += 1;
  }
  return Array.from(groups.values());
}

export function describeStay(store, reservation) {
  const unit = store.db.get('units', reservation.unitId);
  const guest = store.db.get('guests', reservation.guestId);
  return {
    unitCode: unit ? unit.code : '—',
    guestName: guest ? guest.fullName : '—',
    range: `${formatDate(reservation.checkIn)} → ${formatDate(reservation.checkOut)}`
  };
}
