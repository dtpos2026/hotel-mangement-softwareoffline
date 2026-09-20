/**
 * Stock and purchasing.
 *
 * The things that would hurt a property most here are a stock balance that
 * drifts away from the movements that produced it, consumption valued at
 * today's price instead of what was actually paid, and a cancelled purchase
 * quietly removing stock that has already been cooked. All three are covered.
 */

import { installBrowserGlobals, suite, ok, eq, throws, report } from './harness.js';
installBrowserGlobals();

const { AppStore } = await import('../src/core/store.js');
const inv = await import('../src/domain/inventory.js');
const { today, addDays } = await import('../src/core/dates.js');

const store = await AppStore.boot();
store.signIn(store.users().find(u => u.role === 'admin'));
await store.updateProperty({ name: 'Kalam Continental' });

const D0 = today();
const D1 = addDays(D0, 1);
const D2 = addDays(D0, 2);

/* ------------------------------------------------------------ the switch */

suite('The module is off until a property turns it on');
eq('stock starts disabled', inv.isEnabled(store), false);

const sup0 = await inv.saveSupplier(store, { name: 'Swat Traders', phone: '0300-1111111', city: 'Mingora' });
const itemRice0 = await inv.saveItem(store, { name: 'Basmati rice', unit: 'kg', category: 'Kitchen', reorderLevel: 20 });
await throws('a purchase cannot be recorded while it is off',
  () => inv.recordPurchase(store, { supplierId: sup0.id, lines: [{ itemId: itemRice0.id, qty: 10, cost: 300 }] }),
  'switched off');

await store.updateSetting('inventory', Object.assign({}, store.setting('inventory'), { enabled: true }));
eq('switching it on takes effect at once', inv.isEnabled(store), true);

/* -------------------------------------------------------------- suppliers */

suite('Suppliers');
eq('the supplier was saved', sup0.name, 'Swat Traders');
await throws('two suppliers cannot share a name',
  () => inv.saveSupplier(store, { name: 'swat traders' }), 'correct the highlighted');
await throws('a supplier needs a name', () => inv.saveSupplier(store, { name: '  ' }), 'correct the highlighted');

const supB = await inv.saveSupplier(store, { name: 'Kalam Kirana', phone: '0333-2222222', openingBalance: 5000 });
eq('an opening balance is kept', inv.supplierBalance(store, supB.id).opening, 5000);
eq('...and counts as outstanding', inv.supplierBalance(store, supB.id).outstanding, 5000);

const renamed = await inv.saveSupplier(store, { id: supB.id, name: 'Kalam Kirana Store', openingBalance: 999999 });
eq('renaming works', renamed.name, 'Kalam Kirana Store');
eq('the opening balance cannot be rewritten later', renamed.openingBalance, 5000);

/* ------------------------------------------------------------ stock items */

suite('Stock items');
const rice = itemRice0;
const oil = await inv.saveItem(store, { name: 'Cooking oil', code: 'OIL-5L', unit: 'litre', category: 'Kitchen', reorderLevel: 10 });
const soap = await inv.saveItem(store, { name: 'Bath soap', unit: 'piece', category: 'Housekeeping', reorderLevel: 0 });

eq('three items exist', inv.listItems(store).length, 3);
await throws('an item needs a unit of measure',
  () => inv.saveItem(store, { name: 'Salt', unit: 'sack' }), 'correct the highlighted');
await throws('two items cannot share a code',
  () => inv.saveItem(store, { name: 'Other oil', code: 'oil-5l', unit: 'litre' }), 'correct the highlighted');
eq('a new item has nothing on hand', inv.onHand(store, rice.id), 0);
eq('an item with no reorder level is never flagged low', inv.isLow(store, soap), false);
eq('listing by category works', inv.listItems(store, { category: 'Housekeeping' }).length, 1);
eq('searching finds an item by code', inv.listItems(store, { search: 'OIL-5L' }).length, 1);

/* -------------------------------------------------------------- purchases */

suite('A delivery arrives');
const po1 = await inv.recordPurchase(store, {
  supplierId: sup0.id, date: D0, billNo: 'ST-4471',
  lines: [
    { itemId: rice.id, qty: 50, cost: 300 },
    { itemId: oil.id, qty: 20, cost: 600 }
  ],
  paid: 10000
});

eq('the purchase got a number', String(po1.code).startsWith('PO-'), true);
eq('the gross is the sum of the lines', po1.gross, 50 * 300 + 20 * 600);
eq('nothing was discounted', po1.discount, 0);
eq('the total equals the gross when there is no tax', po1.total, 27000);
eq('what was paid is recorded', po1.paid, 10000);
eq('the purchase has two lines', inv.purchaseLines(store, po1.id).length, 2);

eq('the rice reached the shelf', inv.onHand(store, rice.id), 50);
eq('the oil reached the shelf', inv.onHand(store, oil.id), 20);
eq('the rice is valued at what was paid for it', inv.stockValue(store, rice.id), 15000);

const balance1 = inv.supplierBalance(store, sup0.id);
eq('the supplier is owed the unpaid part', balance1.outstanding, 27000 - 10000);

await throws('a purchase needs a supplier',
  () => inv.recordPurchase(store, { supplierId: 'nope', lines: [{ itemId: rice.id, qty: 1, cost: 1 }] }), 'Choose a supplier');
await throws('a purchase needs at least one line',
  () => inv.recordPurchase(store, { supplierId: sup0.id, lines: [] }), 'at least one item');
await throws('a line with no quantity is not a line',
  () => inv.recordPurchase(store, { supplierId: sup0.id, lines: [{ itemId: rice.id, qty: 0, cost: 300 }] }), 'at least one item');

suite('Discount and tax on a bill');
const po2 = await inv.recordPurchase(store, {
  supplierId: supB.id, date: D0,
  lines: [{ itemId: soap.id, qty: 100, cost: 60 }],
  discount: 500, taxPercent: 5, paid: 0
});
eq('the gross is before the discount', po2.gross, 6000);
eq('the discount came off', po2.discount, 500);
eq('tax is charged on the net, not the gross', po2.taxAmount, 275);
eq('the total adds up', po2.total, 6000 - 500 + 275);
ok('the total is a whole number of rupees', Number.isInteger(po2.total));

const over = inv.priceLines([{ itemId: soap.id, qty: 1, cost: 100 }], { discount: 9999 });
eq('a discount can never exceed the gross', over.discount, 100);
eq('...leaving nothing to pay', over.total, 0);

/* ------------------------------------------------------------ consumption */

suite('Stock going out');
await inv.recordMove(store, { itemId: rice.id, qty: 12, reason: 'issue', department: 'Kitchen', date: D1 });
eq('issuing reduces what is on hand', inv.onHand(store, rice.id), 38);

await inv.recordMove(store, { itemId: rice.id, qty: 2, reason: 'wastage', date: D1, notes: 'Spilled' });
eq('wastage reduces it too', inv.onHand(store, rice.id), 36);

await throws('more cannot go out than exists',
  () => inv.recordMove(store, { itemId: oil.id, qty: 999, reason: 'issue' }), 'in stock');

const beforeCost = inv.stockValue(store, rice.id);
eq('what is left is valued at the price it was bought at', beforeCost, 36 * 300);

// A second, dearer delivery must not rewrite what the earlier issue was worth.
const issued = inv.movesFor(store, rice.id).find(m => m.reason === 'issue');
await inv.recordPurchase(store, {
  supplierId: sup0.id, date: D2, lines: [{ itemId: rice.id, qty: 10, cost: 450 }], paid: 4500
});
const issuedAfter = store.db.get('stockMoves', issued.id);
eq('an earlier issue keeps the cost it was made at', issuedAfter.value, 12 * 300);
eq('the new stock arrived', inv.onHand(store, rice.id), 46);
eq('the valuation price follows the newest purchase',
  store.db.get('stockItems', rice.id).lastCost, 450);

suite('A stock take');
await inv.recordMove(store, { itemId: oil.id, qty: 17, reason: 'count', date: D2, notes: 'Monthly count' });
eq('a count sets the figure rather than adding to it', inv.onHand(store, oil.id), 17);
eq('the count is recorded as a movement, not an edit',
  inv.movesFor(store, oil.id).some(m => m.reason === 'count'), true);

suite('Cancelling a movement');
const waste = inv.movesFor(store, rice.id).find(m => m.reason === 'wastage');
await inv.voidMove(store, waste.id, 'Recorded twice');
eq('cancelling a movement puts the stock back', inv.onHand(store, rice.id), 48);
await throws('it cannot be cancelled twice', () => inv.voidMove(store, waste.id), 'already cancelled');

const fromPurchase = inv.movesFor(store, oil.id).find(m => m.purchaseId);
await throws('a purchase movement cannot be cancelled on its own',
  () => inv.voidMove(store, fromPurchase.id), 'Cancel the purchase instead');

/* ------------------------------------------------- cancelling a purchase */

suite('Cancelling a purchase');
const po3 = await inv.recordPurchase(store, {
  supplierId: sup0.id, date: D2, lines: [{ itemId: soap.id, qty: 40, cost: 55 }], paid: 0
});
eq('the soap arrived', inv.onHand(store, soap.id), 140);

const cancelled = await inv.cancelPurchase(store, po3.id, 'Wrong brand');
eq('the purchase is marked cancelled', cancelled.status, 'cancelled');
eq('its stock went back out', inv.onHand(store, soap.id), 100);
eq('the record is kept, not deleted', !!store.db.get('purchases', po3.id), true);
eq('a cancelled purchase is out of the list by default',
  inv.listPurchases(store).some(p => p.id === po3.id), false);
eq('...but can still be looked up',
  inv.listPurchases(store, { includeCancelled: true }).some(p => p.id === po3.id), true);
eq('a cancelled bill is off the supplier account',
  inv.supplierBalance(store, sup0.id).billed, 27000 + 4500);

// The rule that matters: stock already used cannot be un-delivered.
const po4 = await inv.recordPurchase(store, {
  supplierId: sup0.id, date: D2, lines: [{ itemId: oil.id, qty: 5, cost: 620 }], paid: 0
});
await inv.recordMove(store, { itemId: oil.id, qty: 20, reason: 'issue', department: 'Kitchen', date: D2 });
await throws('a purchase whose stock has been used cannot be reversed',
  () => inv.cancelPurchase(store, po4.id), 'already been used');
eq('the refused cancellation changed nothing', store.db.get('purchases', po4.id).status, 'received');
eq('...and left the stock alone', inv.onHand(store, oil.id), 2);

/* ----------------------------------------------------------- paying a bill */

suite('Paying a supplier');
const due = po1.total - po1.paid;
await inv.paySupplier(store, po1.id, 5000);
eq('the payment is recorded against the bill', store.db.get('purchases', po1.id).paid, 15000);
await throws('more than the outstanding cannot be paid',
  () => inv.paySupplier(store, po1.id, due), 'is outstanding');
await throws('nothing is not a payment', () => inv.paySupplier(store, po1.id, 0), 'how much was paid');
await inv.paySupplier(store, po1.id, 12000);
eq('a fully paid bill leaves nothing due',
  store.db.get('purchases', po1.id).total - store.db.get('purchases', po1.id).paid, 0);

/* ------------------------------------------------------------- low stock */

suite('Low stock');
ok('the oil is below its reorder level', inv.isLow(store, store.db.get('stockItems', oil.id)));
ok('the rice is not', !inv.isLow(store, store.db.get('stockItems', rice.id)));
eq('the summary counts what needs ordering', inv.summary(store).lowCount, 1);
ok('the summary names what needs ordering',
  inv.summary(store).lowItems.some(r => r.name === 'Cooking oil'));

/* --------------------------------------------------------------- reports */

suite('Reports');
const onHandRpt = inv.stockOnHandReport(store);
eq('the stock report lists every item', onHandRpt.rows.length, 3);
eq('it values the shelves', onHandRpt.totalValue,
  inv.stockValue(store, rice.id) + inv.stockValue(store, oil.id) + inv.stockValue(store, soap.id));
ok('every valuation is a whole number of rupees',
  onHandRpt.rows.every(r => Number.isInteger(r.value)));

const purchRpt = inv.purchasesReport(store, D0, D2);
ok('the purchase report covers the period', purchRpt.rows.length >= 4);
eq('it excludes the cancelled bill', purchRpt.rows.some(r => r.code === po3.code), false);
eq('billed minus paid is what is due', purchRpt.total - purchRpt.paid, purchRpt.due);

const narrow = inv.purchasesReport(store, D0, D0);
ok('a narrower period returns fewer bills', narrow.rows.length < purchRpt.rows.length);

const balRpt = inv.supplierBalancesReport(store);
ok('the balances report names both suppliers', balRpt.rows.length === 2);
eq('the outstanding total is the sum of the rows',
  balRpt.outstanding, balRpt.rows.reduce((n, r) => n + r.outstanding, 0));

const useRpt = inv.consumptionReport(store, D1, D2);
ok('consumption lists what was used', useRpt.rows.length >= 2);
eq('consumption is valued at what the stock cost', useRpt.value,
  useRpt.rows.reduce((n, r) => n + r.value, 0));
ok('a cancelled movement is left out of consumption',
  useRpt.rows.find(r => r.name === 'Basmati rice').qty === 12);

suite('The stock reports reach the Reports screen');

const allReports = await import('../src/domain/reports.js');

// They must not clutter the Reports screen for a property that does not use
// stock, and must appear the moment it does.
await store.updateSetting('inventory', Object.assign({}, store.setting('inventory'), { enabled: false }));
const hiddenIds = allReports.visibleReports(store).map(r => r.id);
ok('no stock report is offered while the module is off',
  !hiddenIds.some(id => ['stock', 'purchases', 'suppliers', 'consumption'].includes(id)), hiddenIds.join(','));
ok('the ordinary reports are still all there', hiddenIds.length === 13, String(hiddenIds.length));

await store.updateSetting('inventory', Object.assign({}, store.setting('inventory'), { enabled: true }));
const shownIds = allReports.visibleReports(store).map(r => r.id);
ok('all four appear once it is on', shownIds.length === 17, String(shownIds.length));

// Every report on that screen shares one shape, which is what lets one table,
// one CSV exporter and one A4 layout serve all of them.
for (const id of ['stock', 'purchases', 'suppliers', 'consumption']) {
  const rpt = allReports.buildReport(store, id, D0, D2);
  ok(`"${id}" reports its own id`, rpt.id === id, rpt.id);
  ok(`"${id}" has a title`, typeof rpt.title === 'string' && rpt.title.length > 0);
  ok(`"${id}" declares columns`, Array.isArray(rpt.columns) && rpt.columns.length > 0);
  ok(`"${id}" returns rows`, Array.isArray(rpt.rows));
  ok(`"${id}" carries a totals object`, rpt.totals && typeof rpt.totals === 'object');
  ok(`"${id}" summarises itself`, Array.isArray(rpt.summary) && rpt.summary.length > 0);
  ok(`"${id}" every column has a key and a label`,
    rpt.columns.every(c => c.key && c.label));
  ok(`"${id}" every money total is a whole number of rupees`,
    Object.values(rpt.totals).every(v => Number.isInteger(v)));
}

// A point-in-time report must not claim to cover a date range.
eq('stock on hand is not a period report', allReports.buildReport(store, 'stock', D0, D2).range, null);
eq('supplier balances are not a period report', allReports.buildReport(store, 'suppliers', D0, D2).range, null);
ok('purchases is a period report', !!allReports.buildReport(store, 'purchases', D0, D2).range);

// The figures must match what the Stock screen shows, or the two disagree.
const rptStock = allReports.buildReport(store, 'stock', D0, D2);
eq('the report values the shelves the same as the screen',
  rptStock.totals.value, inv.stockOnHandReport(store).totalValue);
const rptSup = allReports.buildReport(store, 'suppliers', D0, D2);
eq('the report owes suppliers the same as the screen',
  rptSup.totals.outstanding, inv.supplierBalancesReport(store).outstanding);

// A4 printing and CSV export both walk columns; a column that names a key the
// rows do not have would print an empty sheet.
const a4 = await import('../src/print/a4.js');
for (const id of ['stock', 'purchases', 'suppliers', 'consumption']) {
  const rpt = allReports.buildReport(store, id, D0, D2);
  const doc = a4.reportDocument(store, rpt);
  ok(`"${id}" prints an A4 sheet`, doc.indexOf(rpt.title) > -1);
  ok(`"${id}" prints its column headings`,
    rpt.columns.every(c => doc.indexOf(c.label) > -1));
}

/* ----------------------------------------------------------- permissions */

suite('Permissions');
const reception = store.users().find(u => u.role === 'receptionist')
  || { id: 'r1', role: 'receptionist', name: 'Reception' };
store.signIn(reception);
await throws('reception cannot record a purchase',
  () => inv.recordPurchase(store, { supplierId: sup0.id, lines: [{ itemId: rice.id, qty: 1, cost: 1 }] }), 'PERMISSION_DENIED');
await throws('reception cannot add a supplier',
  () => inv.saveSupplier(store, { name: 'Anyone' }), 'PERMISSION_DENIED');

const housekeeper = { id: 'hk1', role: 'housekeeping', name: 'Housekeeping' };
store.signIn(housekeeper);
const before = inv.onHand(store, soap.id);
await inv.recordMove(store, { itemId: soap.id, qty: 10, reason: 'issue', department: 'Housekeeping' });
eq('housekeeping may issue stock, which is its job', inv.onHand(store, soap.id), before - 10);
await throws('...but may not void a movement afterwards',
  () => inv.voidMove(store, inv.movesFor(store, soap.id)[0].id), 'PERMISSION_DENIED');

store.signIn(store.users().find(u => u.role === 'admin'));

/* ------------------------------------------------------------- integrity */

suite('The balance always matches the movements');
for (const item of inv.listItems(store)) {
  const moves = inv.movesFor(store, item.id);
  let expected = 0;
  for (const m of moves.slice().reverse()) {
    if (m.direction === 0) expected = m.qty;
    else expected += m.qty * (m.direction < 0 ? -1 : 1);
  }
  eq(`${item.name}: on hand equals the sum of its movements`,
    inv.onHand(store, item.id), Math.round(expected * 1000) / 1000);
}

ok('no movement was ever stored with a negative quantity',
  store.db.all('stockMoves').every(m => Number(m.qty) >= 0));
ok('every purchase line froze the item name it was bought under',
  store.db.all('purchaseLines').every(l => !!l.name && !!l.unit));

process.exit(report() === 0 ? 0 : 1);
