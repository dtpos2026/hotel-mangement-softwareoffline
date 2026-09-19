/**
 * Print renderers. These produce document strings with no DOM involved, so
 * they can be asserted on directly: that every required field from
 * requirements 21 and 22 is present, that compact mode is genuinely shorter,
 * and that the 80mm geometry honours the settings.
 */

import { installBrowserGlobals, suite, ok, eq, report } from './harness.js';
installBrowserGlobals();

const { AppStore } = await import('../src/core/store.js');
const units = await import('../src/domain/units.js');
const guests = await import('../src/domain/guests.js');
const stays = await import('../src/domain/stays.js');
const folio = await import('../src/domain/folio.js');
const payments = await import('../src/domain/payments.js');
const daily = await import('../src/domain/daily.js');
const reports = await import('../src/domain/reports.js');
const r80 = await import('../src/print/receipt80.js');
const a4 = await import('../src/print/a4.js');
const { printerSettings, contentWidthMm } = await import('../src/print/printer.js');
const { today, addDays } = await import('../src/core/dates.js');

const store = await AppStore.boot();
store.signIn(store.users().find(u => u.role === 'admin'));
await store.updateProperty({
  name: 'Kalam Continental', type: 'guesthouse', city: 'Kalam', address: 'Main Bazaar Road',
  phone: '0300-1234567', whatsapp: '0300-1234567', email: 'stay@kalam.pk',
  taxEnabled: true, taxPercent: 5, checkOutTime: '12:00',
  invoiceFooter: 'Payment due on departure.', receiptFooter: 'Thank you — please visit again.'
});

const type = await units.saveUnitType(store, { name: 'Deluxe Double', capacityAdults: 2, capacityChildren: 1, defaultRate: 8500 });
const unit = await units.saveUnit(store, { code: '204', unitTypeId: type.id, floor: 'First', capacityAdults: 2, capacityChildren: 1, baseRate: 8500, extraBedCharge: 1500 });

const { guest, reservation } = await stays.walkIn(store, {
  guest: { fullName: 'Muhammad Bilal', fatherName: 'Abdul Rahman', cnic: '15302-1234567-1', phone: '0300-1234567', address: 'House 4, Gulberg', city: 'Lahore' },
  unitId: unit.id, checkIn: today(), checkOut: addDays(today(), 2),
  adults: 2, children: 1, rate: 8500, extraBeds: 1, discount: 750,
  advance: 10000, paymentMethod: 'cash', comingFrom: 'Islamabad', goingTo: 'Kalam', vehicleNo: 'LEB-1234',
  companions: [{ name: 'Sana Bilal', relation: 'Wife', age: '31' }, { name: 'Hamza Bilal', relation: 'Son', age: '7' }]
});
await folio.addCharge(store, reservation.id, { category: 'food', description: 'Trout fish, Chapli Kabab', qty: 1, rate: 2650 });
const bill = folio.billFor(store, reservation, { live: true });
const ctx = { reservation, guest, unit, bill, servedBy: store.session.name };

/* --------------------------------------------------------------------- 80mm */

suite('80mm thermal — required content (requirement 22)');

const normal = r80.guestBill(store, Object.assign({}, ctx, { mode: 'normal' }));
const required80 = [
  ['property name', 'Kalam Continental'],
  ['phone', '0300-1234567'],
  ['receipt/booking number', reservation.code],
  ['guest name', 'Muhammad Bilal'],
  ['CNIC', '15302-1234567-1'],
  ['unit', '204'],
  ['nights', 'Nights'],
  ['check-in', 'Check-in'],
  ['check-out', 'Check-out'],
  ['extra charges', 'Trout fish'],
  ['discount', 'Discount'],
  ['total', 'TOTAL'],
  ['advance/paid', 'Paid'],
  ['balance', 'BALANCE'],
  ['payment method', 'Cash'],
  ['receipt footer', 'Thank you']
];
required80.forEach(([label, needle]) => ok('bill shows ' + label, normal.indexOf(needle) > -1, needle));
ok('bill is a complete document', normal.startsWith('<!DOCTYPE html>') && normal.endsWith('</html>'));

suite('80mm — page geometry follows settings');

const s = printerSettings(store);
eq('default paper width is 80mm', s.widthMm, 80);
eq('left and right margins are equal by default', s.marginLeftMm, s.marginRightMm);
eq('print area is 72mm — the safe 80mm imaging width', contentWidthMm(s), 72);
ok('page size is declared', normal.indexOf('@page { size: 80mm auto; margin: 0; }') > -1);
ok('body uses the configured margins', normal.indexOf('padding: 3mm 4mm 6mm 4mm') > -1);
ok('content width is set from the margins', normal.indexOf('.r { width: 72mm; }') > -1);

await store.updateSetting('printer', { widthMm: 58, marginLeftMm: 3, marginRightMm: 3 });
const narrow = r80.guestBill(store, ctx);
ok('a 58mm roll re-renders at 58mm', narrow.indexOf('@page { size: 58mm auto') > -1);
ok('58mm print area is 52mm', narrow.indexOf('.r { width: 52mm; }') > -1);
await store.updateSetting('printer', { widthMm: 80, marginLeftMm: 4, marginRightMm: 4 });

suite('80mm — compact mode');

const compact = r80.guestBill(store, Object.assign({}, ctx, { mode: 'compact' }));
const countLines = html => (html.match(/<div class="kv|<tr>/g) || []).length;
eq('compact carries the same number of content lines', countLines(compact), countLines(normal));
required80.forEach(([label, needle]) => {
  if (needle === 'Paid' || needle === 'Thank you') return;
  ok('compact still shows ' + label, compact.indexOf(needle) > -1);
});

// Vertical space is the sum of leading, block gaps and cell padding.
const lead = html => Number(/line-height: ([\d.]+);/.exec(html)[1]);
const gapOf = html => Number(/\.gap \{ height: ([\d.]+)mm/.exec(html)[1]);
const cellPad = html => Number(/table\.items td \{ padding: ([\d.]+)mm/.exec(html)[1]);
const fontOf = html => Number(/body \{[\s\S]*?font-size: ([\d.]+)pt/.exec(html)[1]);

const savedLeading = 1 - lead(compact) / lead(normal);
ok('compact tightens leading by ~15%', savedLeading > 0.1 && savedLeading < 0.25, (savedLeading * 100).toFixed(0) + '%');
ok('compact halves the block gaps', gapOf(compact) < gapOf(normal) * 0.6);
ok('compact tightens row padding', cellPad(compact) < cellPad(normal) * 0.6);
ok('compact drops only one type step', fontOf(normal) - fontOf(compact) === 1, `${fontOf(normal)}pt -> ${fontOf(compact)}pt`);
ok('compact is still readable (>= 9pt)', fontOf(compact) >= 9, fontOf(compact) + 'pt');
ok('compact is shorter overall', compact.length < normal.length);
ok('compact uses no dotted or hairline text', compact.indexOf('border-top: 1px dotted') === -1);

// Modelled page height: leading x lines + gaps + padding.
const estimate = html => {
  const lines = countLines(html);
  const gaps = (html.match(/class="gap"/g) || []).length;
  return lines * fontOf(html) * lead(html) * 0.3528 + gaps * gapOf(html) + lines * cellPad(html);
};
const saving = 1 - estimate(compact) / estimate(normal);
ok('compact saves 30–45% of paper', saving >= 0.30 && saving <= 0.45, (saving * 100).toFixed(1) + '% shorter');

suite('80mm — the other receipts');

const payment = payments.listPayments(store, { reservationId: reservation.id })[0];
const rcpt = r80.paymentReceipt(store, { payment, guest, reservation, unit, balanceAfter: bill.balance });
ok('payment receipt shows its receipt number', rcpt.indexOf(payment.code) > -1);
ok('payment receipt shows the method', rcpt.indexOf('Cash') > -1);
ok('payment receipt shows the amount', rcpt.indexOf('10,000') > -1);

const slip = r80.checkInSlip(store, ctx);
ok('check-in slip lists accompanying guests', slip.indexOf('Sana Bilal') > -1 && slip.indexOf('Hamza Bilal') > -1);
ok('check-in slip shows the nightly rate', slip.indexOf('Rate / night') > -1);

const test1 = r80.testPrint(store, 'normal');
ok('test print states the paper width', test1.indexOf('Paper width') > -1);
ok('test print states the print area', test1.indexOf('72.0 mm') > -1 || test1.indexOf('72 mm') > -1);
ok('test print draws an alignment ruler', test1.indexOf('&#9664;') > -1 && test1.indexOf('&#9654;') > -1);
ok('test print works in compact too', r80.testPrint(store, 'compact').indexOf('Compact') > -1);

const figures = daily.dayFigures(store, today(), { live: true });
const dayslip = r80.dayCloseSlip(store, { figures, closedBy: store.session.name });
ok('day close slip shows the net collection', dayslip.indexOf('NET COLLECTION') > -1);
ok('day close slip shows closing cash', dayslip.indexOf('CLOSING CASH') > -1);

/* ----------------------------------------------------------------------- A4 */

suite('A4 invoice — required content (requirement 21)');

const closed = await stays.checkOut(store, reservation.id, { payment: 5000, paymentMethod: 'easypaisa', acceptBalance: true });
const frozen = folio.billFor(store, closed.reservation);
const inv = a4.invoiceDocument(store, {
  reservation: closed.reservation, guest, unit, bill: frozen,
  invoiceNo: closed.invoice.no, issuedAt: closed.invoice.issuedAt
});
[
  ['property name', 'Kalam Continental'], ['phone', '0300-1234567'],
  ['address', 'Main Bazaar Road'], ['invoice number', closed.invoice.no],
  ['guest name', 'Muhammad Bilal'], ['CNIC', '15302-1234567-1'],
  ['unit', '204'], ['check-in', 'Check-in'], ['check-out', 'Check-out'],
  ['nights', 'Nights'], ['subtotal', 'Subtotal'], ['discount', 'Discount'],
  ['tax', 'Tax'], ['grand total', 'Grand total'], ['advance paid', 'Advance / paid'],
  ['balance', 'Balance'], ['payment method', 'Easypaisa'],
  ['footer note', 'Payment due on departure'], ['amount in words', 'Amount in words']
].forEach(([label, needle]) => ok('invoice shows ' + label, inv.indexOf(needle) > -1, needle));
ok('invoice sets A4 portrait', inv.indexOf('@page { size: A4 portrait') > -1);
ok('invoice carries a page number', inv.indexOf('Page 1 of 1') > -1);
ok('invoice is stamped with its settlement state', inv.indexOf('class="stamp') > -1);

suite('A4 reports');

const reg = reports.registerReport(store, addDays(today(), -7), addDays(today(), 7));
const regDoc = a4.reportDocument(store, reg);
ok('register prints landscape (16 columns)', regDoc.indexOf('@page { size: A4 landscape') > -1);
ok('register shows the Urdu title', regDoc.indexOf('روزنامچہ') > -1);
ok('register shows the period', regDoc.indexOf('Period') > -1);
ok('register shows the generated timestamp', regDoc.indexOf('Generated') > -1);
ok('register repeats the header on every page', regDoc.indexOf('thead { display: table-header-group; }') > -1);
ok('register carries page numbers', /Page \d+ of \d+/.test(regDoc));
ok('register renders its rows', regDoc.indexOf('Muhammad Bilal') > -1);

const occDoc = a4.reportDocument(store, reports.occupancyReport(store, today(), addDays(today(), 2)));
ok('occupancy report prints portrait', occDoc.indexOf('@page { size: A4 portrait') > -1);
ok('occupancy report shows a summary block', occDoc.indexOf('summary__item') > -1);

// Pagination: 90 synthetic rows must land on more than one sheet.
const big = Object.assign({}, reg, { rows: Array.from({ length: 90 }, () => reg.rows[0] || {}) });
const bigDoc = a4.reportDocument(store, big);
const sheets = (bigDoc.match(/class="sheet"/g) || []).length;
ok('a long report paginates', sheets >= 3, sheets + ' sheets');
ok('the last page number matches the sheet count', bigDoc.indexOf(`Page ${sheets} of ${sheets}`) > -1);

const emptyDoc = a4.reportDocument(store, Object.assign({}, reg, { rows: [] }));
ok('an empty report still prints a sheet', emptyDoc.indexOf('No records in this period') > -1);

const card = a4.registrationCard(store, { reservation: closed.reservation, guest, unit });
ok('registration card lists companions', card.indexOf('Sana Bilal') > -1);
ok('registration card shows the register number', card.indexOf(closed.reservation.registerNo) > -1);
ok('registration card shows the Pakistan register fields', card.indexOf('Coming from') > -1 && card.indexOf('Vehicle no') > -1);

const dayDoc = a4.dayCloseDocument(store, { figures, expenses: [] });
ok('day close A4 shows collection by method', dayDoc.indexOf('Collection by method') > -1);

suite('Escaping');
const evil = await guests.saveGuest(store, { fullName: '<script>alert(1)</script> & "Co"', cnic: '11111-2222222-3', phone: '0300-9999999' });
const evilDoc = a4.invoiceDocument(store, { reservation: closed.reservation, guest: evil, unit, bill: frozen, invoiceNo: 'X' });
ok('guest names are HTML-escaped', evilDoc.indexOf('<script>alert(1)</script>') === -1);
ok('escaped text is still shown', evilDoc.indexOf('&lt;script&gt;') > -1);

process.exit(report() === 0 ? 0 : 1);
