/**
 * Restaurant point of sale.
 *
 * Optional: a property switches it on in Settings, and the licence must allow
 * it. When off, nothing here is reached and the nav entry does not appear.
 *
 * The one piece that matters beyond ordinary POS work is posting an order to a
 * room folio. That has to behave exactly like any other folio charge — the
 * kitchen must not become a second, separate ledger — so it writes through
 * folio.addCharge() rather than inventing its own money path.
 */

import { newId, nextSequence, takenSet } from '../core/ids.js';
import {
  makeMenuCategory, makeMenuItem, makeTable, makeOrder, makeOrderLine,
  ORDER_STATUS, TABLE_STATUS, CATEGORY_COLOURS
} from '../core/schema.js';
import { nowIso, today, inRange, dateOfIso } from '../core/dates.js';
import { toMoney, mul, percent, clampPositive } from '../core/money.js';
import { required, positiveInt, collect } from '../core/validate.js';
import { addCharge } from './folio.js';

/* ------------------------------------------------------------- settings */

export function isEnabled(store) {
  return !!store.setting('restaurant').enabled;
}

export function settings(store) {
  const s = store.setting('restaurant');
  return {
    enabled: !!s.enabled,
    serviceChargePercent: Number(s.serviceChargePercent) || 0,
    printKitchenSlip: s.printKitchenSlip !== false,
    allowPostToRoom: s.allowPostToRoom !== false,
    defaultArea: s.defaultArea || 'Main hall'
  };
}

/* --------------------------------------------------------------- menu */

export function listCategories(store, opts) {
  const all = (opts && opts.includeArchived) ? store.db.all('menuCategories') : store.db.live('menuCategories');
  return all.slice().sort((a, b) => (a.sortOrder - b.sortOrder) || String(a.name).localeCompare(String(b.name)));
}

export function listMenuItems(store, opts) {
  const o = opts || {};
  let list = o.includeArchived ? store.db.all('menuItems') : store.db.live('menuItems');
  if (o.categoryId) list = list.filter(i => i.categoryId === o.categoryId);
  if (o.availableOnly) list = list.filter(i => i.available);
  if (o.search) {
    const q = String(o.search).toLowerCase();
    list = list.filter(i => String(i.name).toLowerCase().indexOf(q) > -1
      || String(i.nameUr || '').indexOf(o.search) > -1
      || String(i.code || '').toLowerCase().indexOf(q) > -1);
  }
  return list.slice().sort((a, b) => (a.sortOrder - b.sortOrder) || String(a.name).localeCompare(String(b.name)));
}

export function categoryName(store, id) {
  const c = store.db.get('menuCategories', id);
  return c ? c.name : '—';
}

export async function saveCategory(store, patch) {
  store.session.require('settings.manage');
  const errors = collect({ name: required(patch.name, 'Category name') });
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const existing = patch.id ? store.db.get('menuCategories', patch.id) : null;
  const record = makeMenuCategory(Object.assign({}, existing, patch, {
    id: patch.id || newId('mc'),
    name: String(patch.name).trim(),
    colour: patch.colour || CATEGORY_COLOURS[listCategories(store).length % CATEGORY_COLOURS.length],
    sortOrder: Number(patch.sortOrder) || 0
  }));
  await store.write(existing ? 'menu.categoryUpdate' : 'menu.categoryCreate', (tx, log) => {
    tx.put('menuCategories', record);
    log('menuCategories', record.id, { name: record.name });
  });
  return record;
}

export async function archiveCategory(store, id) {
  store.session.require('settings.manage');
  const record = store.db.get('menuCategories', id);
  if (!record) throw new Error('Category not found.');
  const inUse = store.db.live('menuItems').filter(i => i.categoryId === id).length;
  if (inUse) throw new Error(`${inUse} menu item(s) are in this category. Move them first.`);

  const next = Object.assign({}, record, { active: false, archivedAt: nowIso() });
  await store.write('menu.categoryArchive', (tx, log) => {
    tx.put('menuCategories', next);
    log('menuCategories', id, { name: record.name });
  });
  return next;
}

export function validateMenuItem(store, patch) {
  const duplicate = patch.code ? store.db.live('menuItems').some(i =>
    i.id !== patch.id && String(i.code || '').toLowerCase() === String(patch.code).toLowerCase()) : false;
  return collect({
    name: required(patch.name, 'Item name'),
    categoryId: required(patch.categoryId, 'Category'),
    price: positiveInt(patch.price, 'Price'),
    code: duplicate ? 'Another item already uses this code.' : null
  });
}

export async function saveMenuItem(store, patch) {
  store.session.require('settings.manage');
  const errors = validateMenuItem(store, patch);
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const existing = patch.id ? store.db.get('menuItems', patch.id) : null;
  const record = makeMenuItem(Object.assign({}, existing, patch, {
    id: patch.id || newId('mi'),
    name: String(patch.name).trim(),
    code: String(patch.code || '').trim(),
    price: toMoney(patch.price),
    cost: toMoney(patch.cost),
    available: patch.available !== false,
    sortOrder: Number(patch.sortOrder) || 0
  }));
  await store.write(existing ? 'menu.itemUpdate' : 'menu.itemCreate', (tx, log) => {
    tx.put('menuItems', record);
    log('menuItems', record.id, { name: record.name, price: record.price });
  });
  return record;
}

/**
 * A menu item on a past order keeps the name and price that were charged, so
 * an item is archived rather than deleted once it has been sold.
 */
export async function archiveMenuItem(store, id) {
  store.session.require('settings.manage');
  const item = store.db.get('menuItems', id);
  if (!item) throw new Error('Menu item not found.');
  const next = Object.assign({}, item, { available: false, archivedAt: nowIso() });
  await store.write('menu.itemArchive', (tx, log) => {
    tx.put('menuItems', next);
    log('menuItems', id, { name: item.name });
  });
  return next;
}

/* -------------------------------------------------------------- tables */

export function listTables(store, opts) {
  const o = opts || {};
  let list = o.includeArchived ? store.db.all('tables') : store.db.live('tables');
  if (o.area) list = list.filter(t => t.area === o.area);
  return list.slice().sort((a, b) =>
    String(a.area).localeCompare(String(b.area)) ||
    String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
}

export function areasOf(store) {
  const seen = new Set();
  listTables(store).forEach(t => { if (t.area) seen.add(t.area); });
  return Array.from(seen).sort();
}

export async function saveTable(store, patch) {
  store.session.require('settings.manage');
  const duplicate = store.db.live('tables').some(t =>
    t.id !== patch.id && String(t.code || '').toLowerCase() === String(patch.code || '').toLowerCase());
  const errors = collect({
    code: required(patch.code, 'Table number') || (duplicate ? 'Another table already uses this number.' : null),
    seats: positiveInt(patch.seats, 'Seats')
  });
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const existing = patch.id ? store.db.get('tables', patch.id) : null;
  const record = makeTable(Object.assign({}, existing, patch, {
    id: patch.id || newId('tb'),
    code: String(patch.code).trim(),
    seats: Number(patch.seats) || 4,
    area: String(patch.area || settings(store).defaultArea).trim()
  }));
  await store.write(existing ? 'table.update' : 'table.create', (tx, log) => {
    tx.put('tables', record);
    log('tables', record.id, { code: record.code });
  });
  return record;
}

export async function archiveTable(store, id) {
  store.session.require('settings.manage');
  const table = store.db.get('tables', id);
  if (!table) throw new Error('Table not found.');
  if (openOrderForTable(store, id)) throw new Error('This table has an open order. Close it first.');
  const next = Object.assign({}, table, { active: false, archivedAt: nowIso() });
  await store.write('table.archive', (tx, log) => { tx.put('tables', next); log('tables', id, { code: table.code }); });
  return next;
}

export function openOrderForTable(store, tableId) {
  return store.db.all('orders').find(o =>
    o.tableId === tableId && (o.status === 'open' || o.status === 'served' || o.status === 'billed')) || null;
}

/** The floor plan: every table with whatever is happening on it. */
export function floorPlan(store, area) {
  return listTables(store, { area })
    .map(table => {
      const order = openOrderForTable(store, table.id);
      const bill = order ? billFor(store, order) : null;
      return {
        table,
        order,
        bill,
        status: order ? (order.status === 'billed' ? 'billed' : 'seated') : (table.status === 'reserved' ? 'reserved' : 'free'),
        since: order ? order.openedAt : null
      };
    });
}

/* -------------------------------------------------------------- orders */

export function listOrders(store, opts) {
  const o = opts || {};
  let list = store.db.all('orders');
  if (o.status) list = list.filter(x => Array.isArray(o.status) ? o.status.indexOf(x.status) > -1 : x.status === o.status);
  if (o.type) list = list.filter(x => x.type === o.type);
  if (o.reservationId) list = list.filter(x => x.reservationId === o.reservationId);
  if (o.from || o.to) list = list.filter(x => inRange(dateOfIso(x.openedAt), o.from, o.to));
  return list.slice().sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
}

export function openOrders(store) {
  return listOrders(store, { status: ['open', 'served', 'billed'] });
}

export function linesFor(store, orderId, opts) {
  const all = store.db.where('orderLines', 'orderId', orderId);
  const list = (opts && opts.includeVoided) ? all : all.filter(l => !l.voided);
  return list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** The order total, computed the same way everywhere. */
export function billFor(store, order) {
  if (!order) return { lines: [], gross: 0, discount: 0, net: 0, service: 0, tax: null, taxAmount: 0, total: 0 };
  const lines = linesFor(store, order.id);
  const gross = lines.reduce((s, l) => s + toMoney(l.amount), 0);

  const discount = order.discountType === 'percent'
    ? percent(gross, order.discount)
    : clampPositive(order.discount);
  const afterDiscount = Math.max(0, gross - discount);

  const cfg = settings(store);
  const service = cfg.serviceChargePercent > 0 ? percent(afterDiscount, cfg.serviceChargePercent) : 0;

  const p = store.property;
  const taxEnabled = !!p.taxEnabled && !p.taxInclusive;
  const taxable = afterDiscount + service;
  const taxAmount = taxEnabled ? percent(taxable, Number(p.taxPercent) || 0) : 0;

  return {
    lines, gross, discount,
    discountLabel: order.discountType === 'percent' ? `Discount ${Number(order.discount) || 0}%` : 'Discount',
    net: afterDiscount,
    service, servicePercent: cfg.serviceChargePercent,
    tax: { enabled: taxEnabled, name: p.taxName || 'Tax', percent: Number(p.taxPercent) || 0 },
    taxAmount,
    total: taxable + taxAmount
  };
}

export async function openOrder(store, patch) {
  store.session.require('folio.add');
  if (!isEnabled(store)) throw new Error('The restaurant module is switched off. Turn it on in Settings.');

  const type = patch.type || 'table';
  if (type === 'table') {
    if (!patch.tableId) throw new Error('Choose a table.');
    const existing = openOrderForTable(store, patch.tableId);
    if (existing) return existing;     // one open order per table, not two
  }
  if (type === 'room') {
    if (!patch.reservationId) throw new Error('Choose the room the order is for.');
    const stay = store.db.get('reservations', patch.reservationId);
    if (!stay || stay.status !== 'checked_in') throw new Error('That room does not have a guest checked in.');
  }

  const counters = store.counters();
  let record;
  await store.write('order.open', (tx, log) => {
    const code = nextSequence(tx, counters, 'order', { taken: takenSet(tx.all('orders'), 'code') });
    record = makeOrder(Object.assign({}, patch, {
      id: newId('o'), code, type,
      covers: Number(patch.covers) || 1,
      waiter: patch.waiter || store.session.name,
      openedAt: nowIso(), openedBy: store.session.id
    }));
    tx.put('orders', record);

    if (type === 'table') {
      const table = tx.get('tables', patch.tableId);
      if (table) tx.put('tables', Object.assign({}, table, { status: 'seated' }));
    }
    log('orders', record.id, { code, type });
  });
  return record;
}

export async function addLine(store, orderId, patch) {
  store.session.require('folio.add');
  const order = store.db.get('orders', orderId);
  if (!order) throw new Error('Order not found.');
  if (order.postedToFolio) throw new Error('This order has been posted to a room bill and can no longer be changed.');
  if (order.status === 'paid' || order.status === 'cancelled') throw new Error('This order is closed.');

  const item = patch.menuItemId ? store.db.get('menuItems', patch.menuItemId) : null;
  const name = String(patch.name || (item && item.name) || '').trim();
  if (!name) throw new Error('Choose a menu item.');

  const qty = Number(patch.qty) || 1;
  // The price is copied onto the line, so changing the menu later never
  // rewrites what a guest was charged.
  const price = patch.price !== undefined ? toMoney(patch.price) : toMoney(item && item.price);

  const record = makeOrderLine({
    id: newId('ol'), orderId,
    menuItemId: item ? item.id : '',
    name, nameUr: (item && item.nameUr) || '',
    categoryId: (item && item.categoryId) || '',
    qty, price, amount: mul(price, qty),
    notes: String(patch.notes || ''),
    addedBy: store.session.id
  });

  await store.write('order.addLine', (tx, log) => {
    tx.put('orderLines', record);
    if (order.status === 'served') tx.put('orders', Object.assign({}, order, { status: 'open' }));
    log('orderLines', record.id, { order: order.code, item: name, qty });
  });
  return record;
}

export async function changeLineQty(store, lineId, qty) {
  store.session.require('folio.add');
  const line = store.db.get('orderLines', lineId);
  if (!line) throw new Error('Line not found.');
  const order = store.db.get('orders', line.orderId);
  if (order && (order.status === 'paid' || order.postedToFolio)) throw new Error('This order is closed.');

  const n = Math.max(0, Number(qty) || 0);
  if (n === 0) return voidLine(store, lineId, 'Removed before billing');

  const next = Object.assign({}, line, { qty: n, amount: mul(line.price, n) });
  await store.write('order.changeQty', (tx, log) => {
    tx.put('orderLines', next);
    log('orderLines', lineId, { from: line.qty, to: n });
  });
  return next;
}

export async function voidLine(store, lineId, reason) {
  store.session.require('folio.add');
  const line = store.db.get('orderLines', lineId);
  if (!line) throw new Error('Line not found.');
  const order = store.db.get('orders', line.orderId);
  if (order && (order.status === 'paid' || order.postedToFolio)) throw new Error('This order is closed.');

  // A line already sent to the kitchen needs a reason: the food was cooked.
  if (line.status === 'sent' && !String(reason || '').trim()) {
    throw new Error('This item has already gone to the kitchen. Give a reason for removing it.');
  }

  const next = Object.assign({}, line, {
    voided: true, voidReason: String(reason || ''), status: 'cancelled'
  });
  await store.write('order.voidLine', (tx, log) => {
    tx.put('orderLines', next);
    log('orderLines', lineId, { item: line.name, reason: next.voidReason });
  });
  return next;
}

/** Marks everything pending as sent, which is what the kitchen slip prints. */
export async function sendToKitchen(store, orderId) {
  store.session.require('folio.add');
  const order = store.db.get('orders', orderId);
  if (!order) throw new Error('Order not found.');
  const pending = linesFor(store, orderId).filter(l => l.status === 'pending');
  if (!pending.length) return { order, sent: [] };

  const at = nowIso();
  await store.write('order.sendKitchen', (tx, log) => {
    pending.forEach(l => tx.put('orderLines', Object.assign({}, l, { status: 'sent', sentAt: at })));
    log('orders', orderId, { code: order.code, items: pending.length });
  });
  return { order, sent: pending };
}

export async function markServed(store, orderId) {
  store.session.require('folio.add');
  const order = store.db.get('orders', orderId);
  if (!order) throw new Error('Order not found.');
  const lines = linesFor(store, orderId);
  const next = Object.assign({}, order, { status: 'served', servedAt: nowIso() });
  await store.write('order.served', (tx, log) => {
    lines.filter(l => l.status !== 'served').forEach(l => tx.put('orderLines', Object.assign({}, l, { status: 'served' })));
    tx.put('orders', next);
    log('orders', orderId, { code: order.code });
  });
  return next;
}

export async function setDiscount(store, orderId, discount, discountType) {
  store.session.require('folio.add');
  const order = store.db.get('orders', orderId);
  if (!order) throw new Error('Order not found.');
  if (order.status === 'paid' || order.postedToFolio) throw new Error('This order is closed.');

  const next = Object.assign({}, order, {
    discount: toMoney(discount),
    discountType: discountType === 'percent' ? 'percent' : 'amount'
  });
  await store.write('order.discount', (tx, log) => {
    tx.put('orders', next);
    log('orders', orderId, { code: order.code, discount: next.discount, type: next.discountType });
  });
  return next;
}

export async function billOrder(store, orderId) {
  store.session.require('folio.add');
  const order = store.db.get('orders', orderId);
  if (!order) throw new Error('Order not found.');
  if (!linesFor(store, orderId).length) throw new Error('This order has nothing on it.');

  const next = Object.assign({}, order, { status: 'billed', billedAt: nowIso() });
  await store.write('order.billed', (tx, log) => {
    tx.put('orders', next);
    if (order.tableId) {
      const table = tx.get('tables', order.tableId);
      if (table) tx.put('tables', Object.assign({}, table, { status: 'billed' }));
    }
    log('orders', orderId, { code: order.code });
  });
  return next;
}

/**
 * Settles an order with cash or another method. The restaurant's takings then
 * flow through the same payment ledger as everything else, so the day close
 * reconciles without a second set of books.
 */
export async function settleOrder(store, orderId, opts) {
  store.session.require('payment.create');
  const o = opts || {};
  const order = store.db.get('orders', orderId);
  if (!order) throw new Error('Order not found.');
  if (order.status === 'paid') throw new Error('This order is already paid.');
  if (order.postedToFolio) throw new Error('This order was posted to a room bill; it is settled at check-out.');

  const bill = billFor(store, order);
  const { recordPayment } = await import('./payments.js');
  const payment = await recordPayment(store, {
    reservationId: '', guestId: '',
    amount: bill.total,
    method: o.method || 'cash',
    reference: o.reference || '',
    notes: `Restaurant order ${order.code}`,
    kind: 'payment'
  });

  const next = Object.assign({}, order, {
    status: 'paid', closedAt: nowIso(), closedBy: store.session.id, paymentId: payment.id
  });
  await store.write('order.settled', (tx, log) => {
    tx.put('orders', next);
    freeTable(tx, order.tableId);
    log('orders', orderId, { code: order.code, total: bill.total, method: payment.method });
  });
  return { order: next, payment, bill };
}

/**
 * Posts an order onto a checked-in guest's folio.
 *
 * Goes through folio.addCharge so the restaurant never becomes a parallel
 * ledger: the charge appears on the room bill, in the reports and at check-out
 * exactly like any other extra.
 */
export async function postToRoom(store, orderId, reservationId) {
  store.session.require('folio.add');
  if (!settings(store).allowPostToRoom) throw new Error('Posting to a room is switched off in Settings.');

  const order = store.db.get('orders', orderId);
  if (!order) throw new Error('Order not found.');
  if (order.postedToFolio) throw new Error('This order is already on a room bill.');
  if (order.status === 'paid') throw new Error('This order has already been paid.');

  const stayId = reservationId || order.reservationId;
  const stay = store.db.get('reservations', stayId);
  if (!stay) throw new Error('Choose the room to charge.');
  if (stay.status !== 'checked_in') throw new Error('That room does not have a guest checked in.');

  const bill = billFor(store, order);
  if (bill.total <= 0) throw new Error('This order has nothing on it.');

  const lines = linesFor(store, orderId);
  const summary = lines.slice(0, 3).map(l => l.name).join(', ') + (lines.length > 3 ? ` +${lines.length - 3} more` : '');

  // Post the amount BEFORE tax. The folio applies the property's tax to its
  // own lines, so posting the tax-inclusive total would charge the guest tax
  // twice — once in the restaurant and again on the room bill.
  const postable = bill.net + bill.service;

  const charge = await addCharge(store, stayId, {
    category: 'food',
    description: `Restaurant ${order.code} — ${summary}`,
    qty: 1,
    rate: postable,
    date: today()
  });

  const next = Object.assign({}, order, {
    status: 'paid', reservationId: stayId,
    postedToFolio: true, folioLineId: charge.id,
    closedAt: nowIso(), closedBy: store.session.id
  });
  await store.write('order.postToRoom', (tx, log) => {
    tx.put('orders', next);
    freeTable(tx, order.tableId);
    log('orders', orderId, { code: order.code, reservation: stay.code, posted: postable });
  });
  return { order: next, charge, bill, posted: postable };
}

export async function cancelOrder(store, orderId, reason) {
  store.session.require('folio.void');
  const order = store.db.get('orders', orderId);
  if (!order) throw new Error('Order not found.');
  if (order.status === 'paid') throw new Error('A paid order cannot be cancelled. Record a refund instead.');
  if (!String(reason || '').trim()) throw new Error('A reason is required to cancel an order.');

  const next = Object.assign({}, order, {
    status: 'cancelled', cancelledAt: nowIso(), cancelReason: String(reason).trim()
  });
  await store.write('order.cancel', (tx, log) => {
    tx.put('orders', next);
    freeTable(tx, order.tableId);
    log('orders', orderId, { code: order.code, reason: next.cancelReason });
  });
  return next;
}

function freeTable(tx, tableId) {
  if (!tableId) return;
  const table = tx.get('tables', tableId);
  if (table) tx.put('tables', Object.assign({}, table, { status: 'free' }));
}

/* ------------------------------------------------------------- reporting */

export function salesSummary(store, from, to) {
  const orders = listOrders(store, { from, to }).filter(o => o.status === 'paid');
  const byCategory = new Map();
  const byItem = new Map();
  let gross = 0, discount = 0, service = 0, tax = 0, total = 0;
  let posted = 0, settled = 0;

  for (const order of orders) {
    const bill = billFor(store, order);
    gross += bill.gross; discount += bill.discount;
    service += bill.service; tax += bill.taxAmount; total += bill.total;
    if (order.postedToFolio) posted += bill.total; else settled += bill.total;

    for (const line of bill.lines) {
      const cat = categoryName(store, line.categoryId);
      byCategory.set(cat, (byCategory.get(cat) || 0) + toMoney(line.amount));
      const key = line.name;
      const item = byItem.get(key) || { name: key, qty: 0, amount: 0 };
      item.qty += Number(line.qty) || 0;
      item.amount += toMoney(line.amount);
      byItem.set(key, item);
    }
  }

  return {
    orders: orders.length,
    gross, discount, service, tax, total,
    postedToRooms: posted, settledDirect: settled,
    averageOrder: orders.length ? Math.round(total / orders.length) : 0,
    byCategory: Array.from(byCategory.entries())
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
    topItems: Array.from(byItem.values()).sort((a, b) => b.amount - a.amount).slice(0, 20)
  };
}

export { ORDER_STATUS, TABLE_STATUS };
