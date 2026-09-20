/**
 * WhatsApp message templates and number handling.
 *
 * The templates go to real guests, so what matters is that they never leak a
 * wrong figure, never address the wrong person, and never send at all when the
 * data behind them is missing.
 */

import { installBrowserGlobals, suite, ok, eq, report } from './harness.js';
installBrowserGlobals();

const { AppStore } = await import('../src/core/store.js');
const units = await import('../src/domain/units.js');
const stays = await import('../src/domain/stays.js');
const folio = await import('../src/domain/folio.js');
const payments = await import('../src/domain/payments.js');
const msg = await import('../src/domain/messaging.js');
const { WhatsAppService } = await import('../electron/whatsapp.cjs');
const { today, addDays } = await import('../src/core/dates.js');

const store = await AppStore.boot();
store.signIn(store.users().find(u => u.role === 'admin'));
await store.updateProperty({
  name: 'Kalam Continental', type: 'guesthouse', city: 'Kalam',
  address: 'Main Bazaar Road', phone: '0300-1234567',
  checkInTime: '14:00', checkOutTime: '12:00',
  receiptFooter: 'Thank you — please visit again.'
});

const type = await units.saveUnitType(store, { name: 'Deluxe Double', capacityAdults: 2, capacityChildren: 1, defaultRate: 8500 });
const unit = await units.saveUnit(store, { code: '204', unitTypeId: type.id, floor: 'First', capacityAdults: 2, capacityChildren: 1, baseRate: 8500 });

const { guest, reservation } = await stays.walkIn(store, {
  guest: { fullName: 'Muhammad Bilal', cnic: '15302-1234567-1', phone: '0300-9998877', city: 'Lahore' },
  unitId: unit.id, checkIn: today(), checkOut: addDays(today(), 2),
  adults: 2, children: 1, rate: 8500, advance: 5000, paymentMethod: 'cash'
});

/* -------------------------------------------------------------- numbers */

suite('Phone numbers');
const cases = [
  ['0300-1234567', '923001234567'],
  ['+92 300 1234567', '923001234567'],
  ['0092 300 1234567', '923001234567'],
  ['923001234567', '923001234567'],
  ['0300 123 4567', '923001234567'],
  ['03001234567', '923001234567']
];
for (const [input, expected] of cases) {
  const jid = WhatsAppService.toJid(input);
  eq(`"${input}" becomes ${expected}`, jid && jid.split('@')[0], expected);
}
for (const bad of ['', 'abc', '123', '0300', null, undefined, '00000']) {
  eq(`"${bad}" is refused`, WhatsAppService.toJid(bad), null);
}
eq('a non-Pakistani country code is kept', WhatsAppService.toJid('971501234567', '92').split('@')[0], '971501234567');
eq('the default country code can be changed', WhatsAppService.toJid('0501234567', '971').split('@')[0], '971501234567');

/* ------------------------------------------------------------ templates */

suite('Booking confirmation');
const booking = msg.buildMessage(store, 'booking', { reservation });
ok('it builds', !!booking);
ok('it names the property', booking.text.includes('Kalam Continental'));
ok('it greets the guest by name', booking.text.includes('Muhammad Bilal'));
ok('it gives the booking number', booking.text.includes(reservation.code));
ok('it gives the unit', booking.text.includes('204'));
ok('it states the nights', booking.text.includes('Nights: 2'));
ok('it states check-in and check-out times', booking.text.includes('14:00') && booking.text.includes('12:00'));
ok('it shows the advance already paid', booking.text.includes('Advance received'));
ok('it shows the balance on arrival', booking.text.includes('Balance on arrival'));
ok('it carries the property footer', booking.text.includes('please visit again'));
eq('it targets the guest phone', booking.phone, '0300-9998877');

const bill = folio.billFor(store, reservation);
const { formatMoney } = await import('../src/core/money.js');
ok('the total in the message matches the folio',
  booking.text.includes(formatMoney(bill.total, 'Rs')), formatMoney(bill.total, 'Rs'));
ok('the balance in the message matches the folio',
  booking.text.includes(formatMoney(bill.balance, 'Rs')), formatMoney(bill.balance, 'Rs'));

suite('Other templates');
const checkin = msg.buildMessage(store, 'checkin', { reservation });
ok('check-in message builds', !!checkin && checkin.text.includes('You are checked in'));
ok('check-in message gives the unit', checkin.text.includes('204'));

const balance = msg.buildMessage(store, 'balance', { reservation });
ok('balance reminder builds while money is owed', !!balance);
ok('it marks the amount clearly', balance.text.includes('Balance due'));

const payment = payments.listPayments(store, { reservationId: reservation.id })[0];
const receipt = msg.buildMessage(store, 'payment', { payment });
ok('payment receipt builds', !!receipt);
ok('it gives the receipt number', receipt.text.includes(payment.code));
ok('it gives the method', receipt.text.includes('Cash'));
ok('it gives the amount', receipt.text.includes(formatMoney(payment.amount, 'Rs')));

const custom = msg.buildMessage(store, 'custom', { text: 'Hello there', phone: '0300-0000000' });
eq('a custom message passes straight through', custom.text, 'Hello there');

suite('Templates refuse to build on missing data');
eq('booking needs a reservation', msg.buildMessage(store, 'booking', {}), null);
eq('payment needs a payment', msg.buildMessage(store, 'payment', {}), null);
eq('an unknown template returns nothing', msg.buildMessage(store, 'nonsense', { reservation }), null);

// Settle the stay, then the balance reminder must refuse to send.
await payments.recordPayment(store, {
  reservationId: reservation.id, guestId: guest.id,
  amount: folio.billFor(store, reservation).balance, method: 'cash'
});
eq('balance reminder refuses once nothing is owed', msg.buildMessage(store, 'balance', { reservation }), null);

const settledReceipt = msg.buildMessage(store, 'payment', {
  payment: payments.listPayments(store, { reservationId: reservation.id })[0]
});
ok('a receipt on a settled account says so', settledReceipt.text.includes('fully settled'));

const closed = await stays.checkOut(store, reservation.id, { acceptBalance: true });
const goodbye = msg.buildMessage(store, 'checkout', { reservation: closed.reservation });
ok('check-out message builds', !!goodbye);
ok('it quotes the invoice number', goodbye.text.includes(closed.invoice.no));
ok('it confirms settlement', goodbye.text.includes('Settled in full'));

suite('Template list');
eq('six templates are offered', msg.TEMPLATES.length, 6);
ok('each declares what it needs', msg.TEMPLATES.every(t => ['reservation', 'payment', 'none'].includes(t.needs)));

process.exit(report() === 0 ? 0 : 1);
