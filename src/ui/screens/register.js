/**
 * The guest register (روزنامچہ).
 *
 * This is the prototype's most domain-specific screen and the one Pakistani
 * properties are legally required to keep. Its 16 columns are preserved exactly
 * and it is printable to A4 and exportable to CSV.
 */

import { h } from '../dom.js';
import { card, dataTable, emptyState, pageHead, badge, segmented, filterBar, rangePicker } from '../components.js';
import { ok as toastOk, fail } from '../feedback.js';
import { registerReport } from '../../domain/reports.js';
import { toCsv, downloadFile } from '../../core/backup.js';
import { presetRange, formatDate } from '../../core/dates.js';
import { formatMoney } from '../../core/money.js';
import { printReport } from '../print-actions.js';
import { bookingDetail } from './reservations.js';

const state = { preset: 'month', from: presetRange('month').from, to: presetRange('month').to, filter: 'all' };

export function render(ctx) {
  const { store, app } = ctx;
  const currency = store.currency();
  const report = registerReport(store, state.from, state.to, { filter: state.filter });

  const tabs = [
    { value: 'all', label: 'All movements' },
    { value: 'in', label: 'In' },
    { value: 'out', label: 'Out' },
    { value: 'cleared', label: 'Cleared' },
    { value: 'pending', label: 'Pending clearance' }
  ];

  return [
    pageHead('Register', 'روزنامچہ', [
      h('button.btn', { type: 'button', text: 'Export CSV', onclick: () => exportCsv(report) }),
      h('button.btn.btn--primary', { type: 'button', text: 'Print register (A4)',
        onclick: () => printReport(store, report) })
    ]),

    filterBar([
      rangePicker({ preset: state.preset, from: state.from, to: state.to,
        onChange: r => { state.preset = r.preset; state.from = r.from; state.to = r.to; app.refresh(); } }),
      h('span.push', segmented({ options: tabs, value: state.filter,
        onChange: v => { state.filter = v; app.refresh(); } }))
    ]),

    h('div.kpi-grid', report.summary.map(item => h('div.kpi', [
      h('div.kpi__label', { text: item.label }),
      h('div.kpi__value', { text: item.format === 'money' ? formatMoney(item.value, currency) : String(item.value) })
    ]))),

    card({ flush: true, title: 'Register entries', titleUr: 'روزنامچہ',
           note: `${formatDate(state.from)} — ${formatDate(state.to)}` },
      dataTable({
        currency, compact: true,
        totals: report.totals,
        totalsLabel: `${report.rows.length} entries`,
        columns: report.columns.map(c => {
          if (c.key === 'cleared') {
            return Object.assign({}, c, { render: r => badge(r.cleared, r.cleared === 'Cleared' ? 'ok' : 'warn') });
          }
          if (c.key === 'sno' || c.key === 'cnic' || c.key === 'unit' || c.key === 'vehicle') {
            return Object.assign({}, c, { render: r => h('span.mono.text-sm', { text: String(r[c.key]) }) });
          }
          return c;
        }),
        rows: report.rows,
        onRowClick: row => {
          const r = store.db.first('reservations', x => (x.registerNo || x.code) === row.sno);
          if (r) bookingDetail(ctx, r);
        },
        empty: emptyState({ title: 'No entries in this period', body: 'Check a guest in and the register fills itself.' })
      }))
  ];
}

function exportCsv(report) {
  try {
    downloadFile(`register-${report.range.from}-to-${report.range.to}.csv`,
      toCsv(report.columns, report.rows), 'text/csv;charset=utf-8');
    toastOk('Register exported', 'Open the CSV in Excel or Google Sheets.');
  } catch (err) { fail(err, 'Could not export'); }
}
