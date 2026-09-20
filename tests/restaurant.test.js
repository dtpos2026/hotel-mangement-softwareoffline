/**
 * Restaurant point of sale.
 *
 * The two things that would hurt a property most are a menu price change
 * quietly rewriting an old bill, and restaurant money ending up in a second
 * set of books that the day close never sees. Both are covered here.
 */

import { installBrowserGlobals, suite, ok, eq, throws, report } from './harness.js';
installBrowserGlobals();

const { AppStore } = await import('../src/core/store.js');
const units = await import('../src/domain/units.js');
const stays = await import('../src/domain/stays.js');
const folio = await import('../src/domain/folio.js');
const payments = await import('../src/domain/payments.js');
const daily = await import('../src/domain/daily.js');
const r = await import('../src/domain/restaurant.js');
const { today, addDays } = await import('../src/core/dates.js');

const store = await AppStore.boot();
store.signIn(store.users().find(u => u.role === 'admin'));
await store.updateProperty({ name: 'Kalam Continental', taxEnabled: true, taxPercent: 5 });

/* ----------------------------------------------------------- the switch */

suite('The module is off until a property turns it on');
eq('restaurant starts disabled', r.isEnabled(store), false);
await throws('an order cannot be opened while it is off',
  () => r.openOrder(store, { type: 'takeaway' }), 'switched off');

await store.updateSetting('restaurant', { enabled: true, serviceChargePercent: 10 });
eq('it can be switched on', r.isEnabled(store), true);
eq('the service charge is read back', r.settings(store).serviceChargePercent, 10);

/* ------------------------------------------------------------- the menu */

suite('Menu');
const food = await r.saveCategory(store, { name: 'Food', sortOrder: 1 });
const drinks = await r.saveCategory(store, { name: 'Drinks', sortOrder: 2 });
eq('two categories exist', r.listCategories(store).length, 2);
ok('a category is given a colour automatically', /^#[0-9A-F]{6}$/i.test(food.colour), food.colour);

const trout = await r.saveMenuItem(store, { name: 'Trout Fish', categoryId: food.id, price: 2650, code: 'F01' });
const kabab = await r.saveMenuItem(store, { name: 'Chapli Kabab', categoryId: food.id, price: 900, code: 'F02' });
const chai = await r.saveMenuItem(store, { name: 'Chai', categoryId: drinks.id, price: 150, code: 'D01' });
eq('three items exist', r.listMenuItems(store).length, 3);
eq('items filter by category', r.listMenuItems(store, { categoryId: food.id }).length, 2);
eq('items can be searched', r.listMenuItems(store, { search: 'chai' }).length, 1);
eq('items can be searched by code', r.listMenuItems(store, { search: 'F01' })[0].name, 'Trout Fish');

await throws('a duplicate item code is refused',
  () => r.saveMenuItem(store, { name: 'Other', categoryId: food.id, price: 100, code: 'F01' }), 'correct the highlighted');
await throws('an item needs a category',
  () => r.saveMenuItem(store, { name: 'Loose', price: 100 }), 'correct the highlighted');
await throws('a category with items cannot be archived',
  () => r.archiveCategory(store, food.id), 'Move them first');

/* ------------------------------------------------------------- tables */

suite('Tables and the floor plan');
const t1 = await r.saveTable(store, { code: '1', seats: 4, area: 'Main hall' });
const t2 = await r.saveTable(store, { code: '2', seats: 2, area: 'Main hall' });
const t3 = await r.saveTable(store, { code: 'L1', seats: 6, area: 'Lawn' });
eq('three tables exist', r.listTables(store).length, 3);
eq('areas are collected', r.areasOf(store).sort(), ['Lawn', 'Main hall']);
await throws('a duplicate table number is refused',
  () => r.saveTable(store, { code: '1', seats: 4 }), 'correct the highlighted');

let plan = r.floorPlan(store);
eq('every table starts free', plan.filter(p => p.status === 'free').length, 3);

/* -------------------------------------------------------------- orders */

suite('Taking an order');
const order = await r.openOrder(store, { type: 'table', tableId: t1.id, covers: 3 });
ok('an order number is issued', /^ORD-\d{4}-\d{4}$/.test(order.code), order.code);
eq('the table becomes seated', store.db.get('tables', t1.id).status, 'seated');

const same = await r.openOrder(store, { type: 'table', tableId: t1.id });
eq('opening the same table again returns the existing order', same.id, order.id);

await r.addLine(store, order.id, { menuItemId: trout.id, qty: 1 });
await r.addLine(store, order.id, { menuItemId: kabab.id, qty: 2 });
await r.addLine(store, order.id, { menuItemId: chai.id, qty: 4, notes: 'less sugar' });
eq('three lines are on the order', r.linesFor(store, order.id).length, 3);

const bill1 = r.billFor(store, order);
eq('the gross is the sum of the lines', bill1.gross, 2650 + 1800 + 600);
eq('the service charge is 10% of the net', bill1.service, Math.round(5050 * 0.10));
eq('tax applies after the service charge', bill1.taxAmount, Math.round((5050 + 505) * 0.05));
eq('the total adds up', bill1.total, 5050 + 505 + Math.round(5555 * 0.05));

/* ------------------------------------------- the price-change guarantee */

suite('Changing a menu price never rewrites an open bill');
const before = r.billFor(store, order).total;
await r.saveMenuItem(store, { id: trout.id, name: 'Trout Fish', categoryId: food.id, price: 9999, code: 'F01' });
eq('the bill is unchanged after tripling the menu price', r.billFor(store, order).total, before);
eq('the line kept the price it was sold at', r.linesFor(store, order.id)[0].price, 2650);
const fresh = await r.addLine(store, order.id, { menuItemId: trout.id, qty: 1 });
eq('but a new line takes the new price', fresh.price, 9999);
await r.voidLine(store, fresh.id, 'test');
eq('voiding removes it from the bill', r.billFor(store, order).total, before);

/* ------------------------------------------------------------- kitchen */

suite('Kitchen flow');
eq('lines start pending', r.linesFor(store, order.id).filter(l => l.status === 'pending').length, 3);
const sent = await r.sendToKitchen(store, order.id);
eq('all pending lines are sent', sent.sent.length, 3);
eq('nothing is left pending', r.linesFor(store, order.id).filter(l => l.status === 'pending').length, 0);
eq('sending again sends nothing', (await r.sendToKitchen(store, order.id)).sent.length, 0);

await throws('a line already in the kitchen needs a reason to remove',
  () => r.voidLine(store, r.linesFor(store, order.id)[0].id, ''), 'reason');
ok('with a reason it can be removed', !!(await r.voidLine(store, r.linesFor(store, order.id)[2].id, 'Guest changed their mind')));

await r.markServed(store, order.id);
eq('the order is served', store.db.get('orders', order.id).status, 'served');
await r.addLine(store, order.id, { menuItemId: chai.id, qty: 1 });
eq('adding a late item reopens the order', store.db.get('orders', order.id).status, 'open');

/* ------------------------------------------------------------ settling */

suite('Settling for cash goes through the normal ledger');
const cashOrder = await r.openOrder(store, { type: 'table', tableId: t2.id, covers: 2 });
await r.addLine(store, cashOrder.id, { menuItemId: chai.id, qty: 2 });
await r.billOrder(store, cashOrder.id);
eq('the table reads as billed', store.db.get('tables', t2.id).status, 'billed');

const paymentsBefore = payments.listPayments(store).length;
const settled = await r.settleOrder(store, cashOrder.id, { method: 'cash' });
eq('the order is paid', settled.order.status, 'paid');
eq('the table is free again', store.db.get('tables', t2.id).status, 'free');
eq('a payment was written to the main ledger', payments.listPayments(store).length, paymentsBefore + 1);
eq('for the order total', settled.payment.amount, settled.bill.total);
ok('the payment names the order', settled.payment.notes.includes(cashOrder.code));

const figures = daily.dayFigures(store, today(), { live: true });
ok('restaurant cash appears in the day close', figures.byMethod.find(m => m.id === 'cash').received >= settled.bill.total);

await throws('a paid order cannot be settled twice',
  () => r.settleOrder(store, cashOrder.id, { method: 'cash' }), 'already paid');

/* -------------------------------------------------------- post to room */

suite('Posting to a room bill');
const type = await units.saveUnitType(store, { name: 'Deluxe', capacityAdults: 2, capacityChildren: 1, defaultRate: 8500 });
const unit = await units.saveUnit(store, { code: '204', unitTypeId: type.id, capacityAdults: 2, capacityChildren: 1, baseRate: 8500 });
const { reservation } = await stays.walkIn(store, {
  guest: { fullName: 'Muhammad Bilal', cnic: '15302-1234567-1', phone: '0300-1234567' },
  unitId: unit.id, checkIn: today(), checkOut: addDays(today(), 2), adults: 2, rate: 8500
});

const roomOrder = await r.openOrder(store, { type: 'room', reservationId: reservation.id });
await r.addLine(store, roomOrder.id, { menuItemId: kabab.id, qty: 2 });
const roomBill = r.billFor(store, roomOrder);

const folioBefore = folio.billFor(store, reservation, { live: true }).total;
const posted = await r.postToRoom(store, roomOrder.id, reservation.id);
eq('the order is closed', posted.order.status, 'paid');
eq('it is marked as posted', posted.order.postedToFolio, true);

const folioAfter = folio.billFor(store, reservation, { live: true });
// The pre-tax amount is posted and the folio taxes it once, so the guest ends
// up paying exactly the restaurant total — not that total taxed a second time.
eq('the pre-tax amount is what gets posted', posted.posted, roomBill.net + roomBill.service);
eq('the room bill grows by exactly the restaurant total', folioAfter.total - folioBefore, roomBill.total);
ok('the guest is not taxed twice', folioAfter.total - folioBefore < roomBill.total * 1.04,
  `grew by ${folioAfter.total - folioBefore} for a ${roomBill.total} order`);
ok('the charge names the order', folioAfter.lines.some(l => String(l.description).includes(roomOrder.code)));
ok('the charge is filed under food', folioAfter.lines.some(l => l.category === 'food'));

eq('no second payment was invented', payments.listPayments(store, { reservationId: reservation.id }).length, 0);

await throws('it cannot be posted twice',
  () => r.postToRoom(store, roomOrder.id, reservation.id), 'already on a room bill');
await throws('a posted order cannot take new lines',
  () => r.addLine(store, roomOrder.id, { menuItemId: chai.id, qty: 1 }), 'posted to a room bill');

const emptyRoomOrder = await r.openOrder(store, { type: 'room', reservationId: reservation.id });
await throws('an empty order cannot be posted',
  () => r.postToRoom(store, emptyRoomOrder.id, reservation.id), 'nothing on it');
await r.cancelOrder(store, emptyRoomOrder.id, 'test cleanup');

await throws('a room with nobody in it is refused',
  () => r.openOrder(store, { type: 'room', reservationId: 'nope' }), 'checked in');

/* ------------------------------------------------------------ discounts */

suite('Discounts and cancellation');
const discounted = await r.openOrder(store, { type: 'takeaway' });
await r.addLine(store, discounted.id, { menuItemId: trout.id, qty: 1, price: 1000 });
await r.setDiscount(store, discounted.id, 10, 'percent');
const dBill = r.billFor(store, store.db.get('orders', discounted.id));
eq('a percentage discount is applied', dBill.discount, 100);
eq('and the net reflects it', dBill.net, 900);

await throws('cancelling needs a reason', () => r.cancelOrder(store, discounted.id, ''), 'reason');
await r.cancelOrder(store, discounted.id, 'Guest left');
eq('the order is cancelled', store.db.get('orders', discounted.id).status, 'cancelled');
await throws('a paid order cannot be cancelled',
  () => r.cancelOrder(store, cashOrder.id, 'changed mind'), 'refund instead');

/* ------------------------------------------------------------ reporting */

suite('Sales reporting');
const summary = r.salesSummary(store, today(), today());
ok('paid orders are counted', summary.orders >= 2, String(summary.orders));
ok('a total is produced', summary.total > 0);
ok('money posted to rooms is separated from cash taken', summary.postedToRooms > 0 && summary.settledDirect > 0);
ok('sales are broken down by category', summary.byCategory.length > 0);
ok('top items are listed', summary.topItems.length > 0);
ok('an average order value is computed', summary.averageOrder > 0);

process.exit(report() === 0 ? 0 : 1);
