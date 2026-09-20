/**
 * Expenses (requirement 25). Feeds the day close and the revenue report.
 */

import { h } from '../dom.js';
import { card, dataTable, emptyState, pageHead, badge, kpi, filterBar, filterSelect, rangePicker, moneyText } from '../components.js';
import { promptText, confirm, toast, ok as toastOk, fail } from '../feedback.js';
import { expenseForm } from '../forms.js';
import * as expensesApi from '../../domain/expenses.js';
import { toCsv, downloadFile } from '../../core/backup.js';
import { formatMoney } from '../../core/money.js';
import { presetRange, formatDate, today } from '../../core/dates.js';
import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from '../../core/schema.js';
import { printReport } from '../print-actions.js';
import { expensesReport } from '../../domain/reports.js';

const state = { preset: 'month', from: presetRange('month').from, to: presetRange('month').to, category: '', showVoided: false };

export function render(ctx) {
  const { store, app } = ctx;
  const currency = store.currency();

  const rows = expensesApi.listExpenses(store, {
    from: state.from, to: state.to,
    category: state.category || undefined,
    includeVoided: state.showVoided
  });
  const byCat = expensesApi.totalsByCategory(store, state.from, state.to);
  const byMethod = expensesApi.totalsByMethod(store, state.from, state.to);

  return [
    pageHead('Expenses', 'اخراجات', [
      h('button.btn', { type: 'button', text: 'Export CSV', onclick: () => exportCsv(rows) }),
      h('button.btn', { type: 'button', text: 'Print (A4)',
        onclick: () => printReport(store, expensesReport(store, state.from, state.to)) }),
      store.session.can('expense.create')
        ? h('button.btn.btn--primary', { type: 'button', text: 'Record expense',
            onclick: () => expenseForm(store, { onSaved: () => app.refresh() }) }) : null
    ]),

    filterBar([
      rangePicker({ preset: state.preset, from: state.from, to: state.to,
        onChange: r => { state.preset = r.preset; state.from = r.from; state.to = r.to; app.refresh(); } }),
      filterSelect('Category', state.category,
        [{ value: '', label: 'All categories' }].concat(EXPENSE_CATEGORIES.map(c => ({ value: c, label: c }))),
        v => { state.category = v; app.refresh(); }),
      h('label.check', [
        h('input', { type: 'checkbox', checked: state.showVoided, onchange: e => { state.showVoided = e.target.checked; app.refresh(); } }),
        h('span', { text: 'Show voided' })
      ]),
      h('span.push.text-sm.text-muted', { text: `${rows.length} entry(ies)` })
    ]),

    h('div.kpi-grid', [
      kpi({ label: 'Total expenses', value: formatMoney(byCat.total, currency), tone: 'due' }),
      kpi({ label: 'Paid in cash', value: formatMoney(byMethod.cash || 0, currency) }),
      kpi({ label: 'Paid by bank', value: formatMoney(byMethod.bank || 0, currency) }),
      kpi({ label: 'Entries', value: String(rows.filter(r => !r.voided).length) })
    ]),

    byCat.rows.length ? card({ title: 'By category' },
      h('div.row', { style: { gap: '18px', flexWrap: 'wrap' } }, byCat.rows.map(c => h('div', [
        h('div.field__label', { text: c.category }),
        h('div.mono.strong', { style: { fontSize: '15px' }, text: formatMoney(c.amount, currency) })
      ])))) : null,

    card({ flush: true }, dataTable({
      currency,
      totals: { amount: byCat.total },
      totalsLabel: `${rows.length} entry(ies)`,
      columns: [
        { key: 'code', label: 'No', render: e => h('span.mono.text-muted', { text: e.code || '—' }) },
        { key: 'date', label: 'Date', format: 'date' },
        { key: 'category', label: 'Category' },
        { key: 'description', label: 'Description' },
        { key: 'paidTo', label: 'Paid to' },
        { key: 'method', label: 'Method', render: e => (PAYMENT_METHODS.find(m => m.id === e.method) || {}).label || e.method },
        { key: 'user', label: 'By', render: e => (store.db.get('users', e.userId) || {}).name || '—' },
        { key: 'amount', label: 'Amount', align: 'end', format: 'money' },
        { key: 'act', label: '', render: e => (!e.voided && store.session.can('expense.void'))
            ? h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Void',
                onclick: async () => {
                  const reason = await promptText({ title: `Void expense ${e.code}?`, label: 'Reason',
                    hint: 'The entry stays on record, marked void.', danger: true, confirmLabel: 'Void expense' });
                  if (reason === null) return;
                  try { await expensesApi.voidExpense(store, e.id, reason); toastOk('Expense voided', e.code); }
                  catch (err) { fail(err); }
                } })
            : (e.voided ? badge('Void', 'muted') : null) }
      ],
      rows,
      rowClass: e => e.voided ? 'is-voided' : '',
      empty: emptyState({
        title: 'No expenses in this period',
        body: 'Electricity, cleaning, supplies, staff — anything the property spends.',
        action: store.session.can('expense.create')
          ? h('button.btn.btn--primary', { type: 'button', text: 'Record expense',
              onclick: () => expenseForm(store, { onSaved: () => app.refresh() }) }) : null
      })
    }))
  ];
}

function exportCsv(rows) {
  try {
    const columns = [
      { key: 'code', label: 'No' }, { key: 'date', label: 'Date' },
      { key: 'category', label: 'Category' }, { key: 'description', label: 'Description' },
      { key: 'paidTo', label: 'Paid to' }, { key: 'method', label: 'Method' },
      { key: 'amount', label: 'Amount' }, { key: 'voided', label: 'Voided', value: e => e.voided ? 'Yes' : 'No' }
    ];
    downloadFile('expenses.csv', toCsv(columns, rows), 'text/csv;charset=utf-8');
    toastOk('Expenses exported');
  } catch (err) { fail(err, 'Could not export'); }
}
