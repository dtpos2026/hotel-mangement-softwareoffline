/**
 * WhatsApp message templates.
 *
 * Every template here is transactional — it answers something the guest just
 * did: booked, paid, checked in, checked out. That is deliberate. Unsolicited
 * marketing from an unofficial client is the fastest way to get a property's
 * number banned, and a banned number costs far more than the campaign is worth.
 */

import { formatMoney } from '../core/money.js';
import { formatDate, formatDateTime, nowIso } from '../core/dates.js';
import { billFor } from './folio.js';
import { methodName } from './payments.js';

export const TEMPLATES = [
  { id: 'booking',   label: 'Booking confirmation', needs: 'reservation' },
  { id: 'checkin',   label: 'Check-in details',     needs: 'reservation' },
  { id: 'payment',   label: 'Payment receipt',      needs: 'payment' },
  { id: 'balance',   label: 'Balance reminder',     needs: 'reservation' },
  { id: 'checkout',  label: 'Thank you after check-out', needs: 'reservation' },
  { id: 'custom',    label: 'Custom message',       needs: 'none' }
];

function propertyBlock(store) {
  const p = store.property;
  const lines = [`*${p.name || 'Our property'}*`];
  const where = [p.address, p.city].filter(Boolean).join(', ');
  if (where) lines.push(where);
  if (p.phone) lines.push('Ph: ' + p.phone);
  return lines.join('\n');
}

function signOff(store) {
  const p = store.property;
  return p.receiptFooter ? '\n' + p.receiptFooter : '';
}

/**
 * Builds a message. Returns { text, phone, guest } or null when the data is
 * not there, so a screen can grey the button out rather than send nonsense.
 */
export function buildMessage(store, templateId, ctx) {
  const c = ctx || {};
  const currency = store.currency();
  const word = store.unitWord();
  const money = v => formatMoney(v, currency);

  if (templateId === 'custom') {
    return { text: String(c.text || ''), phone: c.phone || '', guest: c.guest || null };
  }

  if (templateId === 'payment') {
    const payment = c.payment;
    if (!payment) return null;
    const guest = store.db.get('guests', payment.guestId);
    const reservation = payment.reservationId ? store.db.get('reservations', payment.reservationId) : null;
    const bill = reservation ? billFor(store, reservation) : null;

    const lines = [
      propertyBlock(store), '',
      `Dear ${guest ? guest.fullName : 'Guest'},`,
      '',
      `We have received your payment. Thank you.`,
      '',
      `Receipt: ${payment.code}`,
      `Amount: ${money(payment.amount)}`,
      `Method: ${methodName(payment.method)}`,
      `Date: ${formatDateTime(payment.at)}`
    ];
    if (reservation) lines.push(`Booking: ${reservation.code}`);
    if (bill && bill.balance > 0) lines.push('', `Balance remaining: ${money(bill.balance)}`);
    else if (bill) lines.push('', 'Your account is fully settled.');
    lines.push(signOff(store));

    return { text: lines.filter(l => l !== undefined).join('\n'), phone: guest ? guest.phone : '', guest };
  }

  const reservation = c.reservation;
  if (!reservation) return null;
  const guest = store.db.get('guests', reservation.guestId);
  const unit = store.db.get('units', reservation.unitId);
  const bill = billFor(store, reservation);
  const p = store.property;

  const common = [
    propertyBlock(store), '',
    `Dear ${guest ? guest.fullName : 'Guest'},`
  ];

  if (templateId === 'booking') {
    const lines = common.concat([
      '',
      'Your booking is confirmed. The details are below.',
      '',
      `Booking no: ${reservation.code}`,
      `${word}: ${unit ? unit.code : '—'}`,
      `Check-in: ${formatDate(reservation.checkIn)}${p.checkInTime ? ' from ' + p.checkInTime : ''}`,
      `Check-out: ${formatDate(reservation.checkOut)}${p.checkOutTime ? ' by ' + p.checkOutTime : ''}`,
      `Nights: ${reservation.nights}`,
      `Guests: ${reservation.adults} adult(s)${reservation.children ? ', ' + reservation.children + ' child(ren)' : ''}`,
      '',
      `Total: ${money(bill.total)}`
    ]);
    if (bill.paid > 0) lines.push(`Advance received: ${money(bill.paid)}`);
    if (bill.balance > 0) lines.push(`Balance on arrival: ${money(bill.balance)}`);
    lines.push('', 'We look forward to welcoming you.', signOff(store));
    return { text: lines.join('\n'), phone: guest ? guest.phone : '', guest };
  }

  if (templateId === 'checkin') {
    const lines = common.concat([
      '',
      'Welcome. You are checked in.',
      '',
      `${word}: ${unit ? unit.code : '—'}`,
      `Booking no: ${reservation.code}`,
      `Check-out: ${formatDate(reservation.checkOut)}${p.checkOutTime ? ' by ' + p.checkOutTime : ''}`,
      `Nights: ${reservation.nights}`,
      ''
    ]);
    if (bill.balance > 0) lines.push(`Balance to settle: ${money(bill.balance)}`, '');
    lines.push('Please call reception if you need anything.', signOff(store));
    return { text: lines.join('\n'), phone: guest ? guest.phone : '', guest };
  }

  if (templateId === 'balance') {
    if (bill.balance <= 0) return null;
    const lines = common.concat([
      '',
      'This is a polite reminder of the balance on your account.',
      '',
      `Booking no: ${reservation.code}`,
      `${word}: ${unit ? unit.code : '—'}`,
      `Total charges: ${money(bill.total)}`,
      `Paid: ${money(bill.paid)}`,
      `*Balance due: ${money(bill.balance)}*`,
      '',
      'Please settle at reception at your convenience.',
      signOff(store)
    ]);
    return { text: lines.join('\n'), phone: guest ? guest.phone : '', guest };
  }

  if (templateId === 'checkout') {
    const lines = common.concat([
      '',
      'Thank you for staying with us.',
      '',
      `Booking no: ${reservation.code}`,
      reservation.invoiceNo ? `Invoice no: ${reservation.invoiceNo}` : '',
      `Stay: ${formatDate(reservation.checkIn)} to ${formatDate(reservation.checkOut)}`,
      `Total: ${money(bill.total)}`,
      bill.balance > 0 ? `Balance outstanding: ${money(bill.balance)}` : 'Settled in full.',
      '',
      'We hope to see you again.',
      signOff(store)
    ].filter(Boolean));
    return { text: lines.join('\n'), phone: guest ? guest.phone : '', guest };
  }

  return null;
}

/** Records a sent message on the audit trail, so there is proof it went. */
export async function logSent(store, info) {
  await store.write('whatsapp.sent', (tx, log) => {
    log('messages', info.reservationId || info.paymentId || '', {
      template: info.template, to: info.phone, guest: info.guestName, at: nowIso()
    });
  });
}
