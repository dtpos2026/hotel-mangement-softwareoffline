/**
 * Reports (requirement 26). All thirteen share one shape, so one table, one
 * CSV exporter and one A4 layout serve every one of them.
 */

import { h } from '../dom.js';
import { card, dataTable, emptyState, pageHead, kpi, filterBar, rangePicker, segmented, moneyText } from '../components.js';
import { toast, ok as toastOk, fail } from '../feedback.js';
import { REPORTS, buildReport } from '../../domain/reports.js';
import { toCsv, downloadFile } from '../../core/backup.js';
import { formatMoney } from '../../core/money.js';
import { presetRange, formatDate, today } from '../../core/dates.js';
import { printReport } from '../print-actions.js';

const state = { report: 'occupancy', preset: 'month', from: presetRange('month').from, to: presetRange('month').to };

export function render(ctx) {
  const { store, app, params } = ctx;
  const currency = store.currency();

  if (params.report) { state.report = params.report; params.report = null; }

  const report = buildReport(store, state.report, state.from, state.to);
  const needsRange = report.range !== null;

  return [
    pageHead('Reports', 'رپورٹس', [
      h('button.btn', { type: 'button', text: 'Export CSV', onclick: () => exportCsv(report) }),
      h('button.btn.btn--primary', { type: 'button', text: 'Print (A4)', onclick: () => printReport(store, report) })
    ]),

    card({ flush: true }, h('div', { style: { padding: '10px 12px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      REPORTS.map(r => h('button.chip', {
        type: 'button',
        class: r.id === state.report ? 'is-on' : null,
        text: r.label,
        onclick: () => { state.report = r.id; app.refresh(); }
      })))),

    needsRange ? filterBar([
      rangePicker({ preset: state.preset, from: state.from, to: state.to,
        onChange: r => { state.preset = r.preset; state.from = r.from; state.to = r.to; app.refresh(); } }),
      h('span.push.text-sm.text-muted', {
        text: `${formatDate(report.range.from)} — ${formatDate(report.range.to)} · ${report.rows.length} row(s)` })
    ]) : h('div.text-sm.text-muted', { text: `All records · ${report.rows.length} row(s)` }),

    report.summary && report.summary.length
      ? h('div.kpi-grid', report.summary.map(item => h('div.kpi', [
          h('div.kpi__label', { text: item.label }),
          h('div.kpi__value', { text: item.format === 'money' ? formatMoney(item.value, currency) : String(item.value) })
        ])))
      : null,

    card({ title: report.title, titleUr: report.titleUr, flush: true }, dataTable({
      currency,
      compact: report.columns.length > 8,
      totals: report.totals && Object.keys(report.totals).length ? report.totals : null,
      totalsLabel: 'Total',
      columns: report.columns,
      rows: report.rows,
      empty: emptyState({
        title: 'No data for this period',
        body: 'Change the date range above, or pick a different report.'
      })
    }))
  ];
}

function exportCsv(report) {
  try {
    const suffix = report.range ? `-${report.range.from}-to-${report.range.to}` : '';
    downloadFile(`${report.id}${suffix}.csv`, toCsv(report.columns, report.rows), 'text/csv;charset=utf-8');
    toastOk('Report exported', `${report.title} · ${report.rows.length} row(s)`);
  } catch (err) { fail(err, 'Could not export'); }
}
