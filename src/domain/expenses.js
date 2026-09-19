/**
 * Expenses. Optional, but they are what turn the revenue report into a real
 * cash position for the owner (requirements 25 and 24).
 */

import { newId, nextSequence, takenSet } from '../core/ids.js';
import { makeExpense, EXPENSE_CATEGORIES, PAYMENT_METHODS } from '../core/schema.js';
import { nowIso, today, inRange } from '../core/dates.js';
import { toMoney } from '../core/money.js';
import { required, positiveInt, collect } from '../core/validate.js';

export function listExpenses(store, opts) {
  const o = opts || {};
  let list = store.db.all('expenses');
  if (!o.includeVoided) list = list.filter(e => !e.voided);
  if (o.category) list = list.filter(e => e.category === o.category);
  if (o.method) list = list.filter(e => e.method === o.method);
  if (o.from || o.to) list = list.filter(e => inRange(e.date, o.from, o.to));
  return list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function validateExpense(patch) {
  return collect({
    date: required(patch.date, 'Date'),
    category: required(patch.category, 'Category'),
    description: required(patch.description, 'Description'),
    amount: toMoney(patch.amount) <= 0 ? 'Amount must be more than zero.' : positiveInt(patch.amount, 'Amount')
  });
}

export async function recordExpense(store, patch) {
  store.session.require('expense.create');
  const errors = validateExpense(patch);
  if (errors) { const e = new Error('Please correct the highlighted fields.'); e.fields = errors; throw e; }

  const closing = store.db.first('dayClosings', c => c.date === patch.date && c.locked);
  if (closing) throw new Error(`${patch.date} has been closed. Record this expense against an open day.`);

  const counters = store.counters();
  let record;
  await store.write('expense.create', (tx, log) => {
    const code = nextSequence(tx, counters, 'expense', { taken: takenSet(tx.all('expenses'), 'code') });
    record = makeExpense(Object.assign({}, patch, {
      id: newId('e'), code,
      amount: toMoney(patch.amount),
      category: EXPENSE_CATEGORIES.indexOf(patch.category) > -1 ? patch.category : 'Other',
      method: PAYMENT_METHODS.some(m => m.id === patch.method) ? patch.method : 'cash',
      description: String(patch.description).trim(),
      userId: store.session.id,
      createdAt: nowIso()
    }));
    tx.put('expenses', record);
    log('expenses', record.id, { code, amount: record.amount, category: record.category });
  });
  return record;
}

export async function voidExpense(store, id, reason) {
  store.session.require('expense.void');
  const expense = store.db.get('expenses', id);
  if (!expense) throw new Error('Expense not found.');
  if (expense.voided) return expense;
  if (!String(reason || '').trim()) throw new Error('A reason is required to void an expense.');

  const closing = store.db.first('dayClosings', c => c.date === expense.date && c.locked);
  if (closing) throw new Error(`${expense.date} has been closed and its entries are locked.`);

  const next = Object.assign({}, expense, {
    voided: true, voidReason: String(reason).trim(), voidedAt: nowIso(), voidedBy: store.session.id
  });
  await store.write('expense.void', (tx, log) => {
    tx.put('expenses', next);
    log('expenses', id, { code: expense.code, amount: expense.amount, reason: next.voidReason });
  });
  return next;
}

export function totalsByCategory(store, from, to) {
  const list = listExpenses(store, { from: from || today(), to: to || from || today() });
  const map = new Map();
  let total = 0;
  for (const e of list) {
    const amt = toMoney(e.amount);
    total += amt;
    map.set(e.category, (map.get(e.category) || 0) + amt);
  }
  return {
    total,
    rows: Array.from(map.entries()).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
    list
  };
}

export function totalsByMethod(store, from, to) {
  const list = listExpenses(store, { from, to });
  const byMethod = {};
  PAYMENT_METHODS.forEach(m => { byMethod[m.id] = 0; });
  list.forEach(e => { byMethod[e.method] = (byMethod[e.method] || 0) + toMoney(e.amount); });
  return byMethod;
}

export { EXPENSE_CATEGORIES };
