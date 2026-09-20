/**
 * Daily closing (requirement 24).
 *
 * Closing a day freezes its figures and locks the receipts and expenses inside
 * it, so the owner's nightly total cannot quietly change afterwards.
 */

import { h, busy } from '../dom.js';
import { card, dataTable, emptyState, pageHead, kpi, field, alert, badge, totalsRail, railRows, moneyText } from '../components.js';
import { confirm, promptText, ok as toastOk, fail } from '../feedback.js';
import * as dailyApi from '../../domain/daily.js';
import { listExpenses } from '../../domain/expenses.js';
import { listPayments } from '../../domain/payments.js';
import { formatMoney } from '../../core/money.js';
import { today, addDays, formatDate, formatDateTime } from '../../core/dates.js';
import { PAYMENT_METHODS } from '../../core/schema.js';
import { printDaySlip, printDayCloseA4 } from '../print-actions.js';

const state = { date: today(), opening: null, notes: '' };

export function render(ctx) {
  const { store, app } = ctx;
  const currency = store.currency();
  const d = state.date;
  const closing = dailyApi.closingFor(store, d);
  const locked = !!(closing && closing.locked);
  const figures = dailyApi.dayFigures(store, d, {
    live: !locked,
    openingBalance: state.opening !== null ? state.opening : undefined
  });
  const expenses = listExpenses(store, { from: d, to: d });
  const payments = listPayments(store, { from: d, to: d });

  return [
    pageHead('Day close', 'یومیہ بندش', [
      h('button.btn', { type: 'button', text: 'Print slip (80mm)', onclick: () => printDaySlip(store, d, figures) }),
      h('button.btn', { type: 'button', text: 'Print report (A4)',
        onclick: () => printDayCloseA4(store, d, figures, closing ? closing.notes : state.notes) }),
      !locked && store.session.can('day.close')
        ? h('button.btn.btn--primary', { type: 'button', text: 'Close this day',
            onclick: e => doClose(ctx, e.currentTarget, figures) }) : null,
      locked && store.session.can('day.reopen')
        ? h('button.btn.btn--danger', { type: 'button', text: 'Reopen day',
            onclick: () => doReopen(ctx) }) : null
    ]),

    h('div.filters', [
      h('span.filters__label', { text: 'Business date' }),
      h('button.btn.btn--sm', { type: 'button', text: '‹', onclick: () => { state.date = addDays(d, -1); state.opening = null; app.refresh(); } }),
      h('input.input', { type: 'date', value: d, max: today(), style: { width: 'auto' },
        onchange: e => { state.date = e.target.value; state.opening = null; app.refresh(); } }),
      h('button.btn.btn--sm', { type: 'button', text: '›', disabled: d >= today(),
        onclick: () => { state.date = addDays(d, 1); state.opening = null; app.refresh(); } }),
      h('button.btn.btn--sm', { type: 'button', text: 'Today', onclick: () => { state.date = today(); state.opening = null; app.refresh(); } }),
      h('span.push', locked ? badge('Closed', 'ok') : badge('Open', 'warn'))
    ]),

    locked ? alert('ok', `${formatDate(d)} is closed`,
      `Closed by ${closing.closedByName || '—'} on ${formatDateTime(closing.closedAt)}. These figures are frozen; receipts and expenses dated in this day can no longer be voided.` +
      (closing.notes ? `\nNote: ${closing.notes}` : '')) : null,

    closing && !closing.locked && closing.reopenedAt
      ? alert('warn', 'This day was reopened',
          `Reopened by ${(store.db.get('users', closing.reopenedBy) || {}).name || '—'} on ${formatDateTime(closing.reopenedAt)}. Reason: ${closing.reopenReason}`)
      : null,

    h('div.kpi-grid', [
      kpi({ label: 'Opening cash', value: formatMoney(figures.openingBalance, currency) }),
      kpi({ label: 'Received', value: formatMoney(figures.received, currency), tone: 'ok', sub: `${figures.paymentCount} receipt(s)` }),
      kpi({ label: 'Refunds', value: formatMoney(figures.refunded, currency), tone: figures.refunded ? 'due' : undefined }),
      kpi({ label: 'Expenses', value: formatMoney(figures.expenseTotal, currency), tone: figures.expenseTotal ? 'due' : undefined, sub: `${figures.expenseCount} entry(ies)` }),
      kpi({ label: 'Net collection', value: formatMoney(figures.netCollection, currency) }),
      kpi({ label: 'Closing cash', value: formatMoney(figures.closingCash, currency), tone: 'accent' })
    ]),

    h('div.split.split--wide', [
      h('div.stack', [
        card({ title: 'Collection by method', flush: true }, dataTable({
          currency,
          columns: [
            { key: 'label', label: 'Method' },
            { key: 'received', label: 'Received', align: 'end', format: 'money' },
            { key: 'refunded', label: 'Refunded', align: 'end', format: 'money' },
            { key: 'net', label: 'Net', align: 'end', render: m => formatMoney(m.received - m.refunded, currency) }
          ],
          rows: figures.byMethod,
          totals: { received: figures.received, refunded: figures.refunded, net: figures.netCollection }
        })),

        card({ title: "Today's receipts", note: `${payments.length}`, flush: true }, dataTable({
          currency, compact: true,
          columns: [
            { key: 'code', label: 'Receipt' },
            { key: 'at', label: 'Time', format: 'datetime' },
            { key: 'guest', label: 'Guest', render: p => (store.db.get('guests', p.guestId) || {}).fullName || '—' },
            { key: 'method', label: 'Method', render: p => (PAYMENT_METHODS.find(m => m.id === p.method) || {}).label || p.method },
            { key: 'amount', label: 'Amount', align: 'end', format: 'money' }
          ],
          rows: payments,
          empty: emptyState({ title: 'No receipts on this day' })
        })),

        expenses.length ? card({ title: "Today's expenses", note: formatMoney(figures.expenseTotal, currency), flush: true },
          dataTable({
            currency, compact: true,
            columns: [
              { key: 'code', label: 'No' },
              { key: 'category', label: 'Category' },
              { key: 'description', label: 'Description' },
              { key: 'method', label: 'Method', render: e => (PAYMENT_METHODS.find(m => m.id === e.method) || {}).label || e.method },
              { key: 'amount', label: 'Amount', align: 'end', format: 'money' }
            ],
            rows: expenses
          })) : null
      ]),

      h('div.stack', [
        card({ title: 'Cash position' }, h('div.stack', [
          !locked && store.session.can('day.close')
            ? field({ label: 'Opening cash', name: 'opening', type: 'number', min: 0,
                value: figures.openingBalance,
                hint: 'Defaults to yesterday’s closing cash.',
                onInput: e => { state.opening = e.target.value; clearTimeout(render._t); render._t = setTimeout(() => app.refresh(), 350); } })
            : null,
          totalsRail([
            { label: 'Opening cash', value: figures.openingBalance },
            { label: 'Cash received', value: (figures.byMethod.find(m => m.id === 'cash') || {}).received || 0 },
            { label: 'Cash refunded', value: -((figures.byMethod.find(m => m.id === 'cash') || {}).refunded || 0) },
            { label: 'Cash expenses', value: -figures.expenseCash },
            { label: 'Closing cash', value: figures.closingCash, rule: true, kind: 'grand' }
          ], currency)
        ])),

        card({ title: 'Day summary' }, railRows([
          { k: 'Arrivals', v: String(figures.arrivals) },
          { k: 'Departures', v: String(figures.departures) },
          { k: 'Occupied', v: `${figures.occupied} of ${figures.available}` },
          { k: 'Occupancy', v: figures.occupancy + '%' },
          { k: 'Room revenue', v: formatMoney(figures.roomRevenue, currency) },
          { k: 'Outstanding', node: moneyText(figures.outstanding, currency, figures.outstanding > 0 ? 'due' : 'ok') }
        ])),

        card({ title: 'Recent closings', flush: true }, dataTable({
          currency, compact: true,
          columns: [
            { key: 'date', label: 'Date', format: 'date' },
            { key: 'net', label: 'Net', align: 'end', render: c => formatMoney(c.figures.netCollection, currency) },
            { key: 'cash', label: 'Cash', align: 'end', render: c => formatMoney(c.closingCash, currency) },
            { key: 'locked', label: '', render: c => c.locked ? badge('Closed', 'ok') : badge('Reopened', 'warn') }
          ],
          rows: dailyApi.closingHistory(store, 12),
          onRowClick: c => { state.date = c.date; state.opening = null; app.refresh(); },
          empty: emptyState({ title: 'No days closed yet' })
        }))
      ])
    ])
  ];
}

async function doClose(ctx, buttonEl, figures) {
  const { store, app } = ctx;
  const currency = store.currency();
  return busy(buttonEl, async () => {
    const go = await confirm({
      title: `Close ${formatDate(state.date)}?`,
      message: 'The figures below are frozen onto the record. Receipts and expenses dated inside this day can no longer be voided.',
      detail: [
        `Opening cash: ${formatMoney(figures.openingBalance, currency)}`,
        `Received: ${formatMoney(figures.received, currency)}`,
        `Expenses: ${formatMoney(figures.expenseTotal, currency)}`,
        `Net collection: ${formatMoney(figures.netCollection, currency)}`,
        `Closing cash: ${formatMoney(figures.closingCash, currency)}`
      ].join('\n'),
      detailTitle: 'Figures being locked',
      tone: 'info',
      confirmLabel: 'Close the day'
    });
    if (!go) return;

    const notes = await promptText({
      title: 'Note for the record', label: 'Notes', required: false,
      placeholder: 'Cash handed to owner', confirmLabel: 'Close day'
    });
    if (notes === null) return;

    try {
      const record = await dailyApi.closeDay(store, state.date, {
        openingBalance: state.opening !== null ? state.opening : figures.openingBalance,
        notes
      });
      toastOk('Day closed', `${formatDate(state.date)} · net ${formatMoney(record.figures.netCollection, currency)}`);
      state.opening = null;
      printDaySlip(store, state.date, record.figures);
      app.refresh();
    } catch (err) { fail(err); }
  });
}

async function doReopen(ctx) {
  const { store, app } = ctx;
  const reason = await promptText({
    title: `Reopen ${formatDate(state.date)}?`,
    label: 'Reason',
    hint: 'The figures frozen at closing are kept on the record alongside the new ones.',
    placeholder: 'A receipt was entered against the wrong day',
    danger: true, confirmLabel: 'Reopen day'
  });
  if (reason === null) return;
  try {
    await dailyApi.reopenDay(store, state.date, reason);
    toastOk('Day reopened', formatDate(state.date));
    app.refresh();
  } catch (err) { fail(err); }
}
