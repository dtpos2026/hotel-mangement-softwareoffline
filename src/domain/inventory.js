/**
 * Stock and purchasing — the first slice of ERP.
 *
 * Optional, exactly like the restaurant module: a property switches it on in
 * Settings and the licence must allow it. When off, nothing here is reached.
 *
 * Three rules shape everything below.
 *
 *   Stock on hand is never stored. It is the sum of the moves, so a balance
 *   cannot drift away from the history that produced it. A stock take writes a
 *   correcting move rather than overwriting a number.
 *
 *   Every move freezes its own cost. What a bag of rice cost in March stays
 *   what March's consumption was worth, whatever it costs today — the same
 *   rule the invoices already follow.
 *
 *   A purchase is money. It goes through the same integer-rupee arithmetic as
 *   guest billing, and cancelling one reverses its stock rather than deleting
 *   the record.
 */

import { newId, nextSequence, takenSet } from '../core/ids.js';
import {
  makeSupplier, makeStockItem, makeStockMove, makePurchase, makePurchaseLine,
  STOCK_UNITS, STOCK_REASONS
} from '../core/schema.js';
import { nowIso, today, inRange } from '../core/dates.js';
import { toMoney, mul, percent, clampPositive } from '../core/money.js';
import { required, collect } from '../core/validate.js';

/* -------------------------------------------------------------- settings */

export function isEnabled(store) {
  return !!store.setting('inventory').enabled;
}

export function settings(store) {
  const s = store.setting('inventory');
  return {
    enabled: !!s.enabled,
    trackKitchenStock: s.trackKitchenStock !== false,
    warnOnLowStock: s.warnOnLowStock !== false,
    defaultDepartment: s.defaultDepartment || 'Kitchen'
  };
}

export function unitShort(id) {
  const u = STOCK_UNITS.find(x => x.id === id);
  return u ? u.short : id;
}

export function reasonOf(id) {
  return STOCK_REASONS.find(r => r.id === id) || STOCK_REASONS[0];
}

/* ------------------------------------------------------------- suppliers */

export function listSuppliers(store, opts) {
  const o = opts || {};
  let list = o.includeArchived ? store.db.all('suppliers') : store.db.live('suppliers');
  if (o.search) {
    const q = String(o.search).toLowerCase();
    list = list.filter(s => String(s.name).toLowerCase().indexOf(q) > -1
      || String(s.phone || '').indexOf(o.search) > -1
      || String(s.city || '').toLowerCase().indexOf(q) > -1);
  }
  return list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function supplierName(store, id) {
  const s = store.db.get('suppliers', id);
  return s ? s.name : '—';
}

export async function saveSupplier(store, patch) {
  store.session.require('stock.manage');
  const errors = collect({ name: required(patch.name, 'Supplier name') });
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const existing = patch.id ? store.db.get('suppliers', patch.id) : null;
  const name = String(patch.name).trim();
  const clash = listSuppliers(store, { includeArchived: true })
    .find(s => s.id !== (patch.id || '') && String(s.name).toLowerCase() === name.toLowerCase());
  if (clash) {
    const e = new Error('Please correct the highlighted fields.');
    e.fields = { name: 'Another supplier already uses this name.' };
    throw e;
  }

  const record = makeSupplier(Object.assign({}, existing, patch, {
    id: patch.id || newId('sup'),
    name,
    // The opening balance is what they were already owed. It is set once, when
    // the supplier is added, and is not editable afterwards — otherwise a
    // ledger could be rewritten from the top.
    openingBalance: existing ? existing.openingBalance : clampPositive(patch.openingBalance)
  }));

  await store.write(existing ? 'supplier.update' : 'supplier.create', (tx, log) => {
    tx.put('suppliers', record);
    log('suppliers', record.id, { name: record.name });
  });
  return record;
}

export async function archiveSupplier(store, supplierId) {
  store.session.require('stock.manage');
  const supplier = store.db.get('suppliers', supplierId);
  if (!supplier) throw new Error('Supplier not found.');
  const balance = supplierBalance(store, supplierId);
  if (balance.outstanding > 0) {
    throw new Error(`This supplier is still owed ${balance.outstanding}. Settle the account before archiving.`);
  }
  const next = Object.assign({}, supplier, { archivedAt: nowIso() });
  await store.write('supplier.archive', (tx, log) => {
    tx.put('suppliers', next);
    log('suppliers', supplierId, { name: supplier.name });
  });
  return next;
}

/** What a supplier has been billed, what has been paid, and what is left. */
export function supplierBalance(store, supplierId) {
  const supplier = store.db.get('suppliers', supplierId);
  const purchases = store.db.where('purchases', 'supplierId', supplierId)
    .filter(p => p.status !== 'cancelled');
  const billed = purchases.reduce((n, p) => n + toMoney(p.total), 0);
  const paid = purchases.reduce((n, p) => n + toMoney(p.paid), 0);
  const opening = supplier ? toMoney(supplier.openingBalance) : 0;
  return {
    purchases: purchases.length,
    opening,
    billed,
    paid,
    outstanding: Math.max(0, opening + billed - paid)
  };
}

/* ------------------------------------------------------------ stock items */

export function listItems(store, opts) {
  const o = opts || {};
  let list = o.includeArchived ? store.db.all('stockItems') : store.db.live('stockItems');
  if (o.category) list = list.filter(i => i.category === o.category);
  if (o.search) {
    const q = String(o.search).toLowerCase();
    list = list.filter(i => String(i.name).toLowerCase().indexOf(q) > -1
      || String(i.code || '').toLowerCase().indexOf(q) > -1
      || String(i.nameUr || '').indexOf(o.search) > -1);
  }
  const rows = list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return o.lowOnly ? rows.filter(i => isLow(store, i)) : rows;
}

export function itemName(store, id) {
  const i = store.db.get('stockItems', id);
  return i ? i.name : '—';
}

export async function saveItem(store, patch) {
  store.session.require('stock.manage');
  const errors = collect({
    name: required(patch.name, 'Item name'),
    unit: STOCK_UNITS.some(u => u.id === patch.unit) ? null : 'Choose a unit of measure.'
  });
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const existing = patch.id ? store.db.get('stockItems', patch.id) : null;
  const code = String(patch.code || '').trim();
  if (code) {
    const clash = listItems(store, { includeArchived: true })
      .find(i => i.id !== (patch.id || '') && String(i.code).toLowerCase() === code.toLowerCase());
    if (clash) {
      const e = new Error('Please correct the highlighted fields.');
      e.fields = { code: 'Another item already uses this code.' };
      throw e;
    }
  }

  const record = makeStockItem(Object.assign({}, existing, patch, {
    id: patch.id || newId('itm'),
    name: String(patch.name).trim(),
    code,
    reorderLevel: Math.max(0, Number(patch.reorderLevel) || 0),
    // lastCost is written by purchases, never typed in.
    lastCost: existing ? existing.lastCost : clampPositive(patch.lastCost)
  }));

  await store.write(existing ? 'stock.itemUpdate' : 'stock.itemCreate', (tx, log) => {
    tx.put('stockItems', record);
    log('stockItems', record.id, { name: record.name });
  });
  return record;
}

export async function archiveItem(store, itemId) {
  store.session.require('stock.manage');
  const item = store.db.get('stockItems', itemId);
  if (!item) throw new Error('Item not found.');
  if (onHand(store, itemId) !== 0) {
    throw new Error('This item still has stock on hand. Issue or write it off first.');
  }
  const next = Object.assign({}, item, { archivedAt: nowIso() });
  await store.write('stock.itemArchive', (tx, log) => {
    tx.put('stockItems', next);
    log('stockItems', itemId, { name: item.name });
  });
  return next;
}

/* ---------------------------------------------------------------- moves */

export function movesFor(store, itemId) {
  return store.db.where('stockMoves', 'itemId', itemId)
    .filter(m => !m.voided)
    .sort((a, b) => String(b.date).localeCompare(String(a.date))
      || String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Stock on hand: the sum of every move, in order.
 *
 * A `count` move is an absolute correction — a stock take saying "there are
 * actually 7" — so it replaces the running figure rather than adding to it.
 */
export function onHand(store, itemId) {
  const moves = store.db.where('stockMoves', 'itemId', itemId)
    .filter(m => !m.voided)
    .sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.createdAt).localeCompare(String(b.createdAt)));

  let qty = 0;
  for (const m of moves) {
    const n = Number(m.qty) || 0;
    if (m.direction === 0) qty = n;
    else qty += n * (m.direction < 0 ? -1 : 1);
  }
  return round3(qty);
}

/** On hand valued at what it actually cost, not at today's price. */
export function stockValue(store, itemId) {
  const item = store.db.get('stockItems', itemId);
  return mul(item ? item.lastCost : 0, onHand(store, itemId));
}

export function isLow(store, item) {
  const level = Number(item.reorderLevel) || 0;
  if (level <= 0) return false;
  return onHand(store, item.id) <= level;
}

/**
 * Records a movement. Purchases call this through recordPurchase; everything
 * else — issuing to the kitchen, wastage, a stock take — comes through here.
 */
export async function recordMove(store, patch) {
  store.session.require('stock.move');
  const item = store.db.get('stockItems', patch.itemId);
  if (!item) throw new Error('Choose a stock item.');

  const reason = reasonOf(patch.reason);
  const qty = round3(Math.abs(Number(patch.qty) || 0));
  if (!qty && reason.direction !== 0) throw new Error('Enter how much moved.');

  // Going out more than exists would make the balance a lie.
  if (reason.direction < 0) {
    const have = onHand(store, patch.itemId);
    if (qty > have) {
      throw new Error(`Only ${have} ${unitShort(item.unit)} of ${item.name} are in stock.`);
    }
  }

  const cost = patch.cost === undefined || patch.cost === null
    ? toMoney(item.lastCost) : clampPositive(patch.cost);

  const record = makeStockMove({
    id: newId('mv'),
    itemId: patch.itemId,
    date: patch.date || today(),
    reason: reason.id,
    direction: reason.direction,
    qty,
    cost,
    value: mul(cost, qty),
    purchaseId: patch.purchaseId || '',
    department: patch.department || '',
    notes: String(patch.notes || '').trim(),
    userId: store.session.id,
    createdAt: nowIso()
  });

  await store.write('stock.move', (tx, log) => {
    tx.put('stockMoves', record);
    log('stockMoves', record.id, { item: item.name, qty, reason: reason.id });
  });
  return record;
}

/** Moves are never edited, only voided — the history has to stay readable. */
export async function voidMove(store, moveId, note) {
  store.session.require('stock.manage');
  const move = store.db.get('stockMoves', moveId);
  if (!move) throw new Error('Movement not found.');
  if (move.voided) throw new Error('This movement is already cancelled.');
  if (move.purchaseId) throw new Error('This came from a purchase. Cancel the purchase instead.');

  const next = Object.assign({}, move, {
    voided: true, voidedAt: nowIso(), voidedBy: store.session.id,
    voidNote: String(note || '').trim()
  });
  await store.write('stock.moveVoid', (tx, log) => {
    tx.put('stockMoves', next);
    log('stockMoves', moveId, { qty: move.qty, reason: move.reason });
  });
  return next;
}

/* ------------------------------------------------------------ purchases */

export function listPurchases(store, opts) {
  const o = opts || {};
  let list = store.db.all('purchases');
  if (o.supplierId) list = list.filter(p => p.supplierId === o.supplierId);
  if (o.from && o.to) list = list.filter(p => inRange(p.date, o.from, o.to));
  if (!o.includeCancelled) list = list.filter(p => p.status !== 'cancelled');
  return list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))
    || String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function purchaseLines(store, purchaseId) {
  return store.db.where('purchaseLines', 'purchaseId', purchaseId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Totals a set of draft lines, in whole rupees, exactly as billing does. */
export function priceLines(lines, opts) {
  const o = opts || {};
  const priced = (lines || []).map(l => {
    const qty = round3(Math.abs(Number(l.qty) || 0));
    const cost = clampPositive(l.cost);
    return Object.assign({}, l, { qty, cost, amount: mul(cost, qty) });
  });
  const gross = priced.reduce((n, l) => n + l.amount, 0);
  const discount = Math.min(gross, clampPositive(o.discount));
  const net = gross - discount;
  const taxPercent = Math.max(0, Number(o.taxPercent) || 0);
  const taxAmount = taxPercent ? percent(net, taxPercent) : 0;
  return { lines: priced, gross, discount, net, taxPercent, taxAmount, total: net + taxAmount };
}

/**
 * Records a delivery: the bill, its lines, and one stock move per line.
 *
 * All of it in a single transaction, so a purchase can never exist without the
 * stock it brought in, nor stock without the bill that paid for it.
 */
export async function recordPurchase(store, patch) {
  store.session.require('purchase.create');
  if (!isEnabled(store)) throw new Error('Stock and purchasing is switched off in Settings.');

  const supplier = store.db.get('suppliers', patch.supplierId);
  if (!supplier) throw new Error('Choose a supplier.');

  const rawLines = (patch.lines || []).filter(l => l && l.itemId && Number(l.qty) > 0);
  if (!rawLines.length) throw new Error('Add at least one item to the purchase.');

  for (const l of rawLines) {
    if (!store.db.get('stockItems', l.itemId)) throw new Error('One of the items no longer exists.');
  }

  const priced = priceLines(rawLines, { discount: patch.discount, taxPercent: patch.taxPercent });
  const paid = Math.min(priced.total, clampPositive(patch.paid));
  const date = patch.date || today();

  const purchaseId = newId('po');
  const result = await store.write('purchase.create', (tx, log) => {
    const counters = tx.get('counters', 'counters');
    const code = nextSequence(tx, counters, 'purchase', {
      taken: takenSet(store.db.all('purchases'), 'code')
    });

    const purchase = makePurchase({
      id: purchaseId, code,
      supplierId: patch.supplierId,
      date,
      billNo: String(patch.billNo || '').trim(),
      notes: String(patch.notes || '').trim(),
      gross: priced.gross,
      discount: priced.discount,
      taxPercent: priced.taxPercent,
      taxAmount: priced.taxAmount,
      total: priced.total,
      paid,
      status: 'received',
      userId: store.session.id,
      createdAt: nowIso()
    });
    tx.put('purchases', purchase);

    for (const l of priced.lines) {
      const item = store.db.get('stockItems', l.itemId);
      // The name and unit are frozen onto the line: renaming an item later
      // must not rewrite what an old bill says was delivered.
      tx.put('purchaseLines', makePurchaseLine({
        id: newId('pl'), purchaseId,
        itemId: l.itemId, name: item.name, unit: item.unit,
        qty: l.qty, cost: l.cost, amount: l.amount,
        createdAt: nowIso()
      }));

      tx.put('stockMoves', makeStockMove({
        id: newId('mv'), itemId: l.itemId, date,
        reason: 'purchase', direction: 1,
        qty: l.qty, cost: l.cost, value: l.amount,
        purchaseId,
        notes: 'Purchase ' + code,
        userId: store.session.id, createdAt: nowIso()
      }));

      // The newest price becomes the valuation price for what is on hand.
      tx.put('stockItems', Object.assign({}, item, { lastCost: l.cost }));
    }

    log('purchases', purchaseId, { code, supplier: supplier.name, total: priced.total });
    return purchase;
  });

  return result;
}

/**
 * Cancels a purchase and reverses the stock it brought in.
 *
 * Refused when any of that stock has already been used, because reversing it
 * would push the balance below zero and make the history describe something
 * that never happened.
 */
export async function cancelPurchase(store, purchaseId, note) {
  store.session.require('purchase.cancel');
  const purchase = store.db.get('purchases', purchaseId);
  if (!purchase) throw new Error('Purchase not found.');
  if (purchase.status === 'cancelled') throw new Error('This purchase is already cancelled.');

  const lines = purchaseLines(store, purchaseId);
  for (const l of lines) {
    const have = onHand(store, l.itemId);
    if (Number(l.qty) > have) {
      const item = store.db.get('stockItems', l.itemId);
      throw new Error(`${item ? item.name : 'An item'} from this purchase has already been used, so it cannot be reversed. Record wastage or a stock count instead.`);
    }
  }

  const next = Object.assign({}, purchase, {
    status: 'cancelled', cancelledAt: nowIso(), cancelledBy: store.session.id,
    cancelNote: String(note || '').trim()
  });

  await store.write('purchase.cancel', (tx, log) => {
    tx.put('purchases', next);
    for (const move of store.db.where('stockMoves', 'purchaseId', purchaseId)) {
      if (!move.voided) {
        tx.put('stockMoves', Object.assign({}, move, {
          voided: true, voidedAt: nowIso(), voidedBy: store.session.id,
          voidNote: 'Purchase ' + purchase.code + ' cancelled'
        }));
      }
    }
    log('purchases', purchaseId, { code: purchase.code, total: purchase.total });
  });
  return next;
}

/** Pays something off a supplier's account. */
export async function paySupplier(store, purchaseId, amount) {
  store.session.require('purchase.create');
  const purchase = store.db.get('purchases', purchaseId);
  if (!purchase) throw new Error('Purchase not found.');
  if (purchase.status === 'cancelled') throw new Error('This purchase was cancelled.');

  const due = toMoney(purchase.total) - toMoney(purchase.paid);
  const pay = clampPositive(amount);
  if (pay <= 0) throw new Error('Enter how much was paid.');
  if (pay > due) throw new Error(`Only ${due} is outstanding on this bill.`);

  const next = Object.assign({}, purchase, { paid: toMoney(purchase.paid) + pay });
  await store.write('purchase.pay', (tx, log) => {
    tx.put('purchases', next);
    log('purchases', purchaseId, { code: purchase.code, paid: pay });
  });
  return next;
}

/* ------------------------------------------------------------- reporting */

/** What is on the shelves right now, and what it is worth. */
export function stockOnHandReport(store) {
  const rows = listItems(store).map(item => {
    const qty = onHand(store, item.id);
    return {
      id: item.id,
      code: item.code,
      name: item.name,
      category: item.category,
      unit: unitShort(item.unit),
      qty,
      reorderLevel: Number(item.reorderLevel) || 0,
      low: isLow(store, item),
      cost: toMoney(item.lastCost),
      value: mul(item.lastCost, qty)
    };
  });
  return {
    rows,
    totalValue: rows.reduce((n, r) => n + r.value, 0),
    lowCount: rows.filter(r => r.low).length
  };
}

/** Everything bought in a period, with what it cost and what is still owed. */
export function purchasesReport(store, from, to) {
  const rows = listPurchases(store, { from, to }).map(p => ({
    id: p.id,
    code: p.code,
    date: p.date,
    supplier: supplierName(store, p.supplierId),
    billNo: p.billNo,
    total: toMoney(p.total),
    paid: toMoney(p.paid),
    due: Math.max(0, toMoney(p.total) - toMoney(p.paid))
  }));
  return {
    rows,
    total: rows.reduce((n, r) => n + r.total, 0),
    paid: rows.reduce((n, r) => n + r.paid, 0),
    due: rows.reduce((n, r) => n + r.due, 0)
  };
}

/** What each supplier is owed. */
export function supplierBalancesReport(store) {
  const rows = listSuppliers(store).map(s => {
    const b = supplierBalance(store, s.id);
    return {
      id: s.id, name: s.name, phone: s.phone, city: s.city,
      purchases: b.purchases, billed: b.billed, paid: b.paid, outstanding: b.outstanding
    };
  }).filter(r => r.purchases > 0 || r.outstanding > 0);
  return { rows, outstanding: rows.reduce((n, r) => n + r.outstanding, 0) };
}

/** What was used up in a period, by department — the consumption figure. */
export function consumptionReport(store, from, to) {
  const moves = store.db.all('stockMoves')
    .filter(m => !m.voided && m.direction < 0 && inRange(m.date, from, to));

  const byItem = new Map();
  for (const m of moves) {
    const key = m.itemId;
    if (!byItem.has(key)) {
      const item = store.db.get('stockItems', key);
      byItem.set(key, {
        id: key,
        name: item ? item.name : '—',
        unit: item ? unitShort(item.unit) : '',
        qty: 0, value: 0, wastage: 0
      });
    }
    const row = byItem.get(key);
    row.qty = round3(row.qty + (Number(m.qty) || 0));
    row.value += toMoney(m.value);
    if (m.reason === 'wastage') row.wastage = round3(row.wastage + (Number(m.qty) || 0));
  }

  const rows = Array.from(byItem.values()).sort((a, b) => b.value - a.value);
  return { rows, value: rows.reduce((n, r) => n + r.value, 0) };
}

/** The one-line answer the dashboard asks for. */
export function summary(store) {
  const stock = stockOnHandReport(store);
  const balances = supplierBalancesReport(store);
  return {
    items: stock.rows.length,
    stockValue: stock.totalValue,
    lowCount: stock.lowCount,
    lowItems: stock.rows.filter(r => r.low).slice(0, 8),
    suppliersOwed: balances.outstanding
  };
}

/* ------------------------------------------------------------------ util */

/** Quantities are not money: grams and litres need fractions, rupees do not. */
function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}
