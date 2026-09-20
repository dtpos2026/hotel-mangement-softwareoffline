/**
 * The payment ledger (requirement 17). Append-only: no edit, only void with a
 * reason, or a refund — both of which leave the original row in place.
 */

import { h } from '../dom.js';
import { card, dataTable, emptyState, pageHead, badge, moneyText, filterBar, filterSelect, rangePicker, kpi } from '../components.js';
import { promptText, ok as toastOk, fail } from '../feedback.js';
import { paymentForm } from '../forms.js';
import * as paymentsApi from '../../domain/payments.js';
import { unitLabel } from '../../domain/units.js';
import { toCsv, downloadFile } from '../../core/backup.js';
import { formatMoney } from '../../core/money.js';
import { formatDate, formatDateTime, today } from '../../core/dates.js';
import { PAYMENT_METHODS } from '../../core/schema.js';
import { printPaymentReceipt } from '../print-actions.js';

const state = { preset: 'today', from: today(), to: today(), method: '', kind: '', showVoided: false };

export function render(ctx) {
  const { store, app, params } = ctx;
  const currency = store.currency();

  if (params.action === 'new') { params.action = null; setTimeout(() => paymentForm(store, { onSaved: p => { printPaymentReceipt(store, p); app.refresh(); } }), 0); }
  if (params.paymentId) {
    const p = store.db.get('payments', params.paymentId);
    params.paymentId = null;
    if (p) setTimeout(() => printPaymentReceipt(store, p), 0);
  }

  const rows = paymentsApi.listPayments(store, {
    from: state.from, to: state.to,
    method: state.method || undefined,
    kind: state.kind || undefined,
    includeVoided: state.showVoided
  });

  const breakdown = paymentsApi.collectionBreakdown(store, state.from, state.to);
  const outstandingTotal = paymentsApi.outstanding(store).reduce((s, o) => s + o.balance, 0);

  return [
    pageHead('Payments', 'وصولیاں', [
      h('button.btn', { type: 'button', text: 'Export CSV', onclick: () => exportCsv(store, rows) }),
      store.session.can('payment.create')
        ? h('button.btn.btn--primary', { type: 'button', text: 'Take payment',
            onclick: () => paymentForm(store, { onSaved: p => { printPaymentReceipt(store, p); app.refresh(); } }) }) : null
    ]),

    filterBar([
      rangePicker({ preset: state.preset, from: state.from, to: state.to,
        onChange: r => { state.preset = r.preset; state.from = r.from; state.to = r.to; app.refresh(); } }),
      filterSelect('Method', state.method,
        [{ value: '', label: 'All methods' }].concat(PAYMENT_METHODS.map(m => ({ value: m.id, label: m.label }))),
        v => { state.method = v; app.refresh(); }),
      filterSelect('Type', state.kind,
        [{ value: '', label: 'All types' }, { value: 'advance', label: 'Advance' },
         { value: 'payment', label: 'Payment' }, { value: 'refund', label: 'Refund' }],
        v => { state.kind = v; app.refresh(); }),
      h('label.check', [
        h('input', { type: 'checkbox', checked: state.showVoided, onchange: e => { state.showVoided = e.target.checked; app.refresh(); } }),
        h('span', { text: 'Show voided' })
      ])
    ]),

    h('div.kpi-grid', [
      kpi({ label: 'Received', value: formatMoney(breakdown.received, currency), tone: 'ok' }),
      kpi({ label: 'Refunded', value: formatMoney(breakdown.refunded, currency), tone: breakdown.refunded ? 'due' : undefined }),
      kpi({ label: 'Net collection', value: formatMoney(breakdown.net, currency) }),
      kpi({ label: 'Receipts', value: String(rows.filter(r => !r.voided).length) }),
      kpi({ label: 'Outstanding (all time)', value: formatMoney(outstandingTotal, currency),
            tone: outstandingTotal > 0 ? 'due' : undefined,
            onClick: () => app.go('reports', { report: 'outstanding' }) })
    ]),

    card({ title: 'By method', note: `${formatDate(state.from)} — ${formatDate(state.to)}` },
      h('div.row', { style: { gap: '18px', flexWrap: 'wrap' } },
        PAYMENT_METHODS.map(m => h('div', [
          h('div.field__label', { text: m.label }),
          h('div.mono.strong', { style: { fontSize: '16px' }, text: formatMoney(breakdown.byMethod[m.id] || 0, currency) })
        ])))),

    card({ flush: true }, dataTable({
      currency,
      columns: [
        { key: 'code', label: 'Receipt', render: p => h('span.mono.strong', { text: p.code }) },
        { key: 'at', label: 'Date / time', format: 'datetime' },
        { key: 'guest', label: 'Guest', render: p => (store.db.get('guests', p.guestId) || {}).fullName || '—' },
        { key: 'booking', label: 'Booking', render: p => {
            const r = p.reservationId ? store.db.get('reservations', p.reservationId) : null;
            return r ? h('span.mono.text-sm', { text: r.code }) : '—';
          } },
        { key: 'unit', label: store.unitWord(), render: p => {
            const r = p.reservationId ? store.db.get('reservations', p.reservationId) : null;
            return r ? h('span.mono.text-sm', { text: unitLabel(store, r.unitId) }) : '—';
          } },
        { key: 'method', label: 'Method', render: p => (PAYMENT_METHODS.find(m => m.id === p.method) || {}).label || p.method },
        { key: 'kind', label: 'Type', render: p => badge(p.kind, p.kind === 'refund' ? 'due' : p.kind === 'advance' ? 'accent' : 'ok') },
        { key: 'reference', label: 'Reference' },
        { key: 'user', label: 'By', render: p => (store.db.get('users', p.userId) || {}).name || '—' },
        { key: 'amount', label: 'Amount', align: 'end', render: p =>
            moneyText(p.kind === 'refund' ? -p.amount : p.amount, currency, p.kind === 'refund' ? 'due' : 'ok') },
        { key: 'act', label: '', render: p => h('div.row.row--tight', [
            h('button.btn.btn--sm', { type: 'button', text: 'Receipt', onclick: () => printPaymentReceipt(store, p) }),
            (!p.voided && store.session.can('payment.void'))
              ? h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Void',
                  onclick: async () => {
                    const reason = await promptText({
                      title: `Void receipt ${p.code}?`,
                      label: 'Reason', hint: 'The receipt stays on record, marked void, with this reason.',
                      placeholder: 'Entered twice by mistake', danger: true, confirmLabel: 'Void receipt'
                    });
                    if (reason === null) return;
                    try { await paymentsApi.voidPayment(store, p.id, reason); toastOk('Receipt voided', p.code); }
                    catch (err) { fail(err); }
                  } }) : null,
            p.voided ? badge('Void', 'muted') : null
          ]) }
      ],
      rows,
      rowClass: p => p.voided ? 'is-voided' : '',
      empty: emptyState({
        title: 'No payments in this period',
        body: 'Change the date range, or record a payment.',
        action: store.session.can('payment.create')
          ? h('button.btn.btn--primary', { type: 'button', text: 'Take payment',
              onclick: () => paymentForm(store, { onSaved: () => app.refresh() }) }) : null
      })
    }))
  ];
}

function exportCsv(store, rows) {
  try {
    const columns = [
      { key: 'code', label: 'Receipt' },
      { key: 'at', label: 'Date', value: p => formatDateTime(p.at) },
      { key: 'guest', label: 'Guest', value: p => (store.db.get('guests', p.guestId) || {}).fullName || '' },
      { key: 'booking', label: 'Booking', value: p => (store.db.get('reservations', p.reservationId) || {}).code || '' },
      { key: 'method', label: 'Method', value: p => (PAYMENT_METHODS.find(m => m.id === p.method) || {}).label || p.method },
      { key: 'kind', label: 'Type' },
      { key: 'reference', label: 'Reference' },
      { key: 'amount', label: 'Amount' },
      { key: 'voided', label: 'Voided', value: p => p.voided ? 'Yes' : 'No' },
      { key: 'voidReason', label: 'Void reason' }
    ];
    downloadFile('payments.csv', toCsv(columns, rows), 'text/csv;charset=utf-8');
    toastOk('Payments exported');
  } catch (err) { fail(err, 'Could not export'); }
}
