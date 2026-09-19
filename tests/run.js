/**
 * The acceptance checklist from requirement 39, run against the real domain
 * layer. Every numbered item there has at least one check here.
 */

import { installBrowserGlobals, suite, ok, eq, throws, report } from './harness.js';
installBrowserGlobals();

const { AppStore } = await import('../src/core/store.js');
const units = await import('../src/domain/units.js');
const guests = await import('../src/domain/guests.js');
const reservations = await import('../src/domain/reservations.js');
const stays = await import('../src/domain/stays.js');
const folio = await import('../src/domain/folio.js');
const payments = await import('../src/domain/payments.js');
const housekeeping = await import('../src/domain/housekeeping.js');
const expenses = await import('../src/domain/expenses.js');
const daily = await import('../src/domain/daily.js');
const reports = await import('../src/domain/reports.js');
const search = await import('../src/domain/search.js');
const dashboard = await import('../src/domain/dashboard.js');
const backup = await import('../src/core/backup.js');
const { today, addDays } = await import('../src/core/dates.js');
const money = await import('../src/core/money.js');
const { Database } = await import('../src/core/db.js');
const { COLLECTIONS } = await import('../src/core/schema.js');

const D0 = today();
const D1 = addDays(D0, 1);
const D2 = addDays(D0, 2);
const D3 = addDays(D0, 3);
const D5 = addDays(D0, 5);

let store = await AppStore.boot();
store.signIn(store.users().find(u => u.role === 'admin'));

/* ------------------------------------------------------------------ 1 · 2 · 3 */

suite('1–3 · Property, unit type and unit');

await store.updateProperty({ name: 'Kalam Continental', type: 'guesthouse', city: 'Kalam', phone: '0300-1234567', taxEnabled: true, taxPercent: 5 });
ok('property saved', store.property.name === 'Kalam Continental');
ok('property type is generic', store.property.type === 'guesthouse');
ok('unit word follows property type', store.unitWord() === 'Room');

const tDeluxe = await units.saveUnitType(store, { name: 'Deluxe Double', capacityAdults: 2, capacityChildren: 1, defaultRate: 8500, weekendRate: 9500, extraBedCharge: 1500 });
const tFamily = await units.saveUnitType(store, { name: 'Family Suite', capacityAdults: 4, capacityChildren: 2, defaultRate: 14000 });
const tCottage = await units.saveUnitType(store, { name: 'Cottage', capacityAdults: 6, capacityChildren: 2, defaultRate: 20000 });
ok('three unit types exist', units.listUnitTypes(store).length === 3);
ok('a non-room accommodation type is supported', !!tCottage.id);

const u101 = await units.saveUnit(store, { code: '101', unitTypeId: tDeluxe.id, floor: 'Ground', capacityAdults: 2, capacityChildren: 1, baseRate: 8500, weekendRate: 9500, extraBedCharge: 1500 });
const u102 = await units.saveUnit(store, { code: '102', unitTypeId: tDeluxe.id, floor: 'Ground', capacityAdults: 2, capacityChildren: 1, baseRate: 8500 });
const u201 = await units.saveUnit(store, { code: '201', unitTypeId: tFamily.id, floor: 'First', capacityAdults: 4, capacityChildren: 2, baseRate: 14000 });
const c07 = await units.saveUnit(store, { code: 'Cottage 07', unitTypeId: tCottage.id, floor: 'Garden', capacityAdults: 6, capacityChildren: 2, baseRate: 20000 });
ok('four units exist', units.listUnits(store).length === 4);
ok('a named (non-numeric) unit is accepted', c07.code === 'Cottage 07');

await throws('duplicate unit number is refused', () => units.saveUnit(store, { code: '101', unitTypeId: tDeluxe.id, baseRate: 5000 }), 'correct the highlighted');

/* ----------------------------------------------------------------------- 4 */

suite('4 · Guests');

const gBilal = await guests.saveGuest(store, { fullName: 'Muhammad Bilal', cnic: '15302-1234567-1', phone: '0300-1234567', city: 'Lahore', comingFrom: 'Islamabad' });
ok('guest saved with a code', !!gBilal.code);
ok('CNIC is normalised', gBilal.cnic === '15302-1234567-1');

const gAgain = await guests.saveGuest(store, { fullName: 'M. Bilal', cnic: '15302-1234567-1', phone: '0300-1234567', email: 'bilal@example.com' });
ok('same CNIC reuses the existing profile', gAgain.id === gBilal.id);
ok('guest count did not grow', guests.listGuests(store).length === 1);
ok('new detail was merged in', gAgain.email === 'bilal@example.com');

const gAyesha = await guests.saveGuest(store, { fullName: 'Ayesha Khan', cnic: '35202-9988771-4', phone: '0321-8899001', city: 'Lahore' });
await throws('a bad CNIC is refused', () => guests.saveGuest(store, { fullName: 'Bad Cnic', cnic: '123' }), 'correct the highlighted');
ok('guest search by CNIC works', guests.searchGuests(store, '35202').length === 1);
ok('guest search by phone works', guests.searchGuests(store, '0300-1234567')[0].id === gBilal.id);

/* --------------------------------------------------------------------- 5 · 6 */

suite('5–6 · Reservations and double-booking protection');

const r1 = await reservations.createReservation(store, {
  guestId: gBilal.id, unitId: u101.id, checkIn: D0, checkOut: D2,
  adults: 2, children: 1, source: 'phone', comingFrom: 'Islamabad', goingTo: 'Kalam', vehicleNo: 'LEB-1234'
});
ok('booking created with a booking number', /^RES-\d{4}-\d{4}$/.test(r1.code));
ok('register serial issued', /^\d{4}-\d{4}$/.test(r1.registerNo));
eq('nights computed', r1.nights, 2);
ok('rate snapshot frozen', !!r1.rateSnapshot && r1.rateSnapshot.nights.length === 2);

const overlap = await throws('exact overlap is refused',
  () => reservations.createReservation(store, { guestId: gAyesha.id, unitId: u101.id, checkIn: D0, checkOut: D2, adults: 1 }),
  'DOUBLE_BOOKING');
ok('refusal message is the required wording', overlap.message === 'Room/Unit is unavailable for the selected dates.');
ok('conflicting booking is reported back', overlap.conflicts.length === 1 && overlap.conflicts[0].code === r1.code);

await throws('partial overlap is refused',
  () => reservations.createReservation(store, { guestId: gAyesha.id, unitId: u101.id, checkIn: D1, checkOut: D3, adults: 1 }),
  'DOUBLE_BOOKING');
await throws('enclosing range is refused',
  () => reservations.createReservation(store, { guestId: gAyesha.id, unitId: u101.id, checkIn: addDays(D0, -1), checkOut: D3, adults: 1 }),
  'DOUBLE_BOOKING');

const turnover = await reservations.createReservation(store, { guestId: gAyesha.id, unitId: u101.id, checkIn: D2, checkOut: D3, adults: 1 });
ok('same-day turnover is allowed', turnover.status === 'reserved');
await reservations.cancelReservation(store, turnover.id, 'test cleanup');
ok('cancelling frees the dates', reservations.conflictsFor(store, u101.id, D2, D3).length === 0);

ok('another unit on the same dates is fine',
  reservations.checkAvailability(store, u102.id, D0, D2).available === true);
ok('availableUnits excludes the booked unit',
  reservations.availableUnits(store, D0, D2).every(u => u.id !== u101.id));

await throws('a stay that ends before it starts is refused',
  () => reservations.createReservation(store, { guestId: gAyesha.id, unitId: u102.id, checkIn: D2, checkOut: D0, adults: 1 }),
  'correct the highlighted');
await throws('over-capacity is refused',
  () => reservations.createReservation(store, { guestId: gAyesha.id, unitId: u102.id, checkIn: D0, checkOut: D1, adults: 9 }),
  'OVER_CAPACITY');

const grid = reservations.availabilityGrid(store, D0, D3);
ok('availability grid covers every unit', grid.rows.length === 4);
ok('grid marks the booked nights', grid.rows.find(r => r.unit.id === u101.id).sold === 2);

/* --------------------------------------------------------------------- 7 · 8 */

suite('7–9 · Walk-in, advance, extra charges, payment');

const walk = await stays.walkIn(store, {
  guest: { fullName: 'Zahid Ullah', cnic: '17301-4455662-9', phone: '0345-7712345', city: 'Mardan' },
  unitId: u201.id, checkIn: D0, checkOut: D1, adults: 2, children: 0,
  rate: 14000, advance: 10000, paymentMethod: 'cash', source: 'walkin'
});
ok('walk-in created the guest', !!walk.guest.id);
ok('walk-in checked the guest in', walk.reservation.status === 'checked_in');
ok('unit is now occupied', store.db.get('units', u201.id).status === 'occupied');
ok('advance was receipted', payments.listPayments(store, { reservationId: walk.reservation.id })[0].amount === 10000);

await folio.addCharge(store, walk.reservation.id, { category: 'food', description: 'Trout fish, Chapli Kabab', qty: 1, rate: 2650 });
await folio.addCharge(store, walk.reservation.id, { category: 'laundry', description: 'Laundry', qty: 3, rate: 150 });
const bill1 = folio.billFor(store, walk.reservation);
eq('room charge from the frozen snapshot', bill1.roomCharge, 14000);
eq('folio gross includes extras', bill1.gross, 14000 + 2650 + 450);
eq('tax applied at 5%', bill1.taxAmount, Math.round((14000 + 2650 + 450) * 0.05));
eq('balance = total − advance', bill1.balance, bill1.total - 10000);

await payments.recordPayment(store, { reservationId: walk.reservation.id, guestId: walk.guest.id, amount: 5000, method: 'easypaisa' });
const bill2 = folio.billFor(store, walk.reservation);
eq('second payment reduces the balance', bill2.paid, 15000);

/* -------------------------------------------------------------------- 10-14 */

suite('10–14 · Check-out, outstanding balance, housekeeping, maintenance');

const outstandingBefore = bill2.balance;
ok('there is a balance to settle', outstandingBefore > 0);

await throws('check-out with a balance needs confirmation',
  () => stays.checkOut(store, walk.reservation.id, {}), 'BALANCE_CONFIRM');

const closed = await stays.checkOut(store, walk.reservation.id, { acceptBalance: true });
ok('stay closed', closed.reservation.status === 'checked_out');
ok('invoice number issued', /^INV-\d{4}-\d{4}$/.test(closed.invoice.no));
eq('invoice recorded the outstanding balance', closed.invoice.balanceAtIssue, outstandingBefore);
ok('unit went to cleaning', store.db.get('units', u201.id).status === 'cleaning');
ok('unit marked dirty', store.db.get('units', u201.id).hkStatus === 'dirty');
ok('a housekeeping task was raised', housekeeping.tasks(store, { open: true }).some(t => t.unitId === u201.id));

const frozenTotal = closed.invoice.totalAtIssue;
await units.saveUnit(store, { id: u201.id, code: '201', unitTypeId: tFamily.id, floor: 'First', capacityAdults: 4, capacityChildren: 2, baseRate: 25000 });
const billAfterPriceChange = folio.billFor(store, store.db.get('reservations', walk.reservation.id));
eq('raising the rate did NOT change the historical invoice', billAfterPriceChange.total, frozenTotal);
ok('the historical bill is served frozen', billAfterPriceChange.frozen === true);

await housekeeping.setHkStatus(store, u201.id, 'cleaning');
ok('housekeeper started cleaning', store.db.get('units', u201.id).hkStatus === 'cleaning');
await housekeeping.setHkStatus(store, u201.id, 'clean');
ok('unit is clean', store.db.get('units', u201.id).hkStatus === 'clean');
ok('clean unit is sellable again', store.db.get('units', u201.id).status === 'available');
await throws('an illegal housekeeping jump is refused',
  () => housekeeping.setHkStatus(store, u201.id, 'cleaning'), 'cannot go straight');

const mt = await housekeeping.openMaintenance(store, { unitId: u102.id, reason: 'Geyser replacement', startDate: D0, expectedEnd: D2 });
ok('unit is under maintenance', store.db.get('units', u102.id).status === 'maintenance');
await throws('a unit under maintenance cannot be booked',
  () => reservations.createReservation(store, { guestId: gAyesha.id, unitId: u102.id, checkIn: D0, checkOut: D1, adults: 1 }),
  'UNIT_UNAVAILABLE');
await housekeeping.closeMaintenance(store, mt.id);
ok('maintenance closed, unit back in the cycle', store.db.get('units', u102.id).status === 'cleaning');

/* -------------------------------------------------------------------- 15-18 */

suite('15–18 · Expenses, reports and daily closing');

await expenses.recordExpense(store, { date: D0, category: 'Electricity', description: 'WAPDA bill', amount: 12000, method: 'cash' });
await expenses.recordExpense(store, { date: D0, category: 'Supplies', description: 'Towels', amount: 3500, method: 'cash' });
eq('expenses total', expenses.totalsByCategory(store, D0, D0).total, 15500);

const reg = reports.registerReport(store, addDays(D0, -7), D5);
ok('register report has the required 16 columns', reg.columns.length === 16);
ok('register report has rows', reg.rows.length >= 1);

const occ = reports.occupancyReport(store, D0, D1);
ok('occupancy report computes ADR', occ.rows[0].adr >= 0);
const pay = reports.paymentsReport(store, D0, D0);
eq('payment report total matches the ledger', pay.totals.amount, 15000);
const outRep = reports.outstandingReport(store);
ok('outstanding report lists the unsettled stay', outRep.rows.some(r => r.balance > 0));

const figures = daily.dayFigures(store, D0, { live: true });
eq('cash received today', figures.byMethod.find(m => m.id === 'cash').received, 10000);
eq('easypaisa received today', figures.byMethod.find(m => m.id === 'easypaisa').received, 5000);
eq('expenses in the day figures', figures.expenseTotal, 15500);
eq('closing cash = opening + cash in − cash expenses', figures.closingCash, 0 + 10000 - 15500);

const closing = await daily.closeDay(store, D0, { openingBalance: 0, notes: 'test close' });
ok('day is closed and locked', closing.locked === true);
await throws('closing the same day twice is refused', () => daily.closeDay(store, D0), 'already closed');
await throws('an expense cannot be added to a closed day',
  () => expenses.recordExpense(store, { date: D0, category: 'Other', description: 'late', amount: 100, method: 'cash' }), 'has been closed');
const firstPayment = payments.listPayments(store)[payments.listPayments(store).length - 1];
await throws('a receipt in a closed day cannot be voided',
  () => payments.voidPayment(store, firstPayment.id, 'mistake'), 'has been closed');
eq('closed totals stay frozen', daily.dayFigures(store, D0).netCollection, closing.figures.netCollection);

/* -------------------------------------------------------------------- 19-24 */

suite('19–24 · Search, CSV, backup, restore, persistence');

ok('search finds a guest by name', search.globalSearch(store, 'Bilal').some(r => r.type === 'guest'));
ok('search finds a booking by number', search.globalSearch(store, r1.code).some(r => r.type === 'reservation'));
ok('search finds a unit by number', search.globalSearch(store, '101').some(r => r.type === 'unit'));
ok('search finds an invoice by number', search.globalSearch(store, closed.invoice.no).some(r => r.type === 'invoice'));

const csv = backup.toCsv(reg.columns, reg.rows);
ok('CSV has a header row', csv.split('\r\n')[0].indexOf('S.No') > -1);
ok('CSV has one line per row', csv.trim().split('\r\n').length === reg.rows.length + 1);

const snapshot = backup.buildBackup(store);
ok('backup carries a format marker', snapshot.format === 'hms-offline-backup');
ok('backup counted the reservations', snapshot.counts.reservations === store.db.all('reservations').length);
ok('a good backup validates', backup.validateBackup(snapshot).ok === true);

eq('a foreign file is rejected', backup.validateBackup({ hello: 'world' }).ok, false);
eq('a corrupt collection is rejected', backup.validateBackup({ format: 'hms-offline-backup', data: { units: 'nope' } }).ok, false);

const dup = JSON.parse(JSON.stringify(snapshot));
dup.data.invoices.push(Object.assign({}, dup.data.invoices[0], { id: 'x' }));
eq('a duplicate invoice number is rejected', backup.validateBackup(dup).ok, false);

const guestsBefore = guests.listGuests(store).length;
await throws('a failed restore leaves data untouched',
  () => backup.restoreBackup(store, { format: 'hms-offline-backup', data: { units: 'nope' } }), 'INVALID_BACKUP');
eq('data survived the failed restore', guests.listGuests(store).length, guestsBefore);

const extra = await guests.saveGuest(store, { fullName: 'Temp Guest', cnic: '11111-1111111-1', phone: '0300-0000000' });
ok('a guest was added after the backup', guests.listGuests(store).length === guestsBefore + 1);
await backup.restoreBackup(store, snapshot);
eq('restore rolled the dataset back', guests.listGuests(store).length, guestsBefore);
ok('the post-backup guest is gone', !store.db.get('guests', extra.id));

await store.db.flush();
const reopened = await Database.open(COLLECTIONS);
eq('data persists across a reload', reopened.all('reservations').length, store.db.all('reservations').length);
eq('guests persist across a reload', reopened.all('guests').length, guests.listGuests(store).length);
const persistedInvoice = reopened.all('invoices').find(i => i.no === closed.invoice.no);
eq('the frozen invoice total survived the reload', persistedInvoice.totalAtIssue, frozenTotal);

/* -------------------------------------------------------------------- 25-29 */

suite('25–29 · Data integrity, permissions, dashboard');

await throws('a unit with history cannot be deleted', () => units.deleteUnit(store, u101.id), 'HAS_HISTORY');
await throws('a guest with history cannot be deleted', () => guests.deleteGuest(store, gBilal.id), 'HAS_HISTORY');
const archived = await units.archiveUnit(store, c07.id);
ok('an unused unit archives instead', !!archived.archivedAt);
ok('archived units leave the live board', units.listUnits(store).every(u => u.id !== c07.id));

const codes = store.db.all('reservations').map(r => r.code);
eq('no duplicate booking numbers', codes.length, new Set(codes).size);
const invNos = store.db.all('invoices').map(i => i.no);
eq('no duplicate invoice numbers', invNos.length, new Set(invNos).size);
const rcpNos = store.db.all('payments').map(p => p.code);
eq('no duplicate receipt numbers', rcpNos.length, new Set(rcpNos).size);

const reception = store.db.all('users').find(u => u.role === 'receptionist') || { id: 'tmp', name: 'Test Reception', role: 'receptionist', active: true };
store.signIn(reception);
ok('reception may take a payment', store.session.can('payment.create'));
ok('reception may not void a payment', !store.session.can('payment.void'));
ok('reception may not open settings', !store.session.can('settings.manage'));
ok('reception may not restore a backup', !store.session.can('backup.manage'));
await throws('reception cannot change printer settings',
  () => store.updateSetting('printer', { widthMm: 58 }), 'PERMISSION_DENIED');
await throws('reception cannot change the tax rate',
  () => store.updateProperty({ taxPercent: 0 }), 'PERMISSION_DENIED');
await throws('reception cannot archive a unit',
  () => units.archiveUnit(store, u102.id), 'PERMISSION_DENIED');
await throws('reception cannot close the day',
  () => daily.closeDay(store, D1), 'PERMISSION_DENIED');
const langBefore = store.setting('app').language;
await store.updateSetting('app', { language: 'ur' });
ok('but reception may still switch language', store.setting('app').language === 'ur');
await store.updateSetting('app', { language: langBefore });

store.signIn(store.users().find(u => u.role === 'admin'));
await store.updateSetting('printer', { widthMm: 80 });
ok('admin may change printer settings', store.setting('printer').widthMm === 80);

const dash = dashboard.dashboardData(store, D0);
ok('dashboard counts units', dash.totals.units === units.listUnits(store).length);
ok('dashboard reports occupancy', typeof dash.occupancy === 'number');
ok('dashboard lists arrivals', Array.isArray(dash.arrivals));
ok('dashboard shows outstanding money', dash.outstanding >= 0);
ok('dashboard shows recent activity', dash.recent.length > 0);

suite('Money and dates');
eq('money parses a formatted string', money.toMoney('14,000'), 14000);
eq('money never produces a float', money.percent(22800, 5), 1140);
eq('money formats with grouping', money.formatMoney(12050, 'Rs'), 'Rs 12,050');
ok('amount in words uses the lakh system', money.amountInWords(150000).indexOf('Lakh') > -1);

process.exit(report() === 0 ? 0 : 1);
