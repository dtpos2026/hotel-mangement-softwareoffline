/**
 * Housekeeping and maintenance (requirements 18 and 19).
 *
 * The board is grouped by what a housekeeper actually does next, and the
 * status buttons only offer the transitions the domain allows.
 */

import { h } from '../dom.js';
import { card, dataTable, emptyState, pageHead, hkBadge, unitBadge, badge, kpi,
         filterBar, filterSelect, segmented, alert } from '../components.js';
import { confirm, toast, ok as toastOk, fail } from '../feedback.js';
import { maintenanceForm } from '../forms.js';
import * as hkApi from '../../domain/housekeeping.js';
import { listUnits, unitTypeName, floorsOf, countByHkStatus } from '../../domain/units.js';
import { HK_STATUS } from '../../core/schema.js';
import { formatDate, formatDateTime, today } from '../../core/dates.js';
import { printReport } from '../print-actions.js';
import { housekeepingReport } from '../../domain/reports.js';

const state = { view: 'board', hkStatus: '', floor: '' };

export function render(ctx) {
  const { store, app } = ctx;
  const word = store.unitWord();
  const counts = countByHkStatus(store);
  const rows = hkApi.board(store, { hkStatus: state.hkStatus || undefined, floor: state.floor || undefined });
  const openMaint = hkApi.openMaintenanceList(store);

  return [
    pageHead('Housekeeping', 'صفائی', [
      h('button.btn', { type: 'button', text: 'Print report (A4)',
        onclick: () => printReport(store, housekeepingReport(store, today(), today())) }),
      store.session.can('maintenance.manage')
        ? h('button.btn.btn--primary', { type: 'button', text: 'New maintenance',
            onclick: () => maintenanceForm(store, { onSaved: () => app.refresh() }) }) : null
    ]),

    h('div.kpi-grid', [
      kpi({ label: 'Dirty', value: String(counts.dirty || 0), tone: counts.dirty ? 'due' : undefined,
            sub: 'waiting to be cleaned', onClick: () => { state.hkStatus = 'dirty'; app.refresh(); } }),
      kpi({ label: 'Being cleaned', value: String(counts.cleaning || 0), tone: 'river',
            onClick: () => { state.hkStatus = 'cleaning'; app.refresh(); } }),
      kpi({ label: 'Clean', value: String(counts.clean || 0), tone: 'ok',
            onClick: () => { state.hkStatus = 'clean'; app.refresh(); } }),
      kpi({ label: 'Inspected', value: String(counts.inspected || 0), tone: 'ok',
            onClick: () => { state.hkStatus = 'inspected'; app.refresh(); } }),
      kpi({ label: 'Ready to sell', value: String(hkApi.readyCount(store)),
            sub: 'clean and free' }),
      kpi({ label: 'Under maintenance', value: String(openMaint.length),
            tone: openMaint.length ? 'due' : undefined })
    ]),

    openMaint.length ? card({ title: 'Open maintenance', flush: true }, dataTable({
      compact: true,
      columns: [
        { key: 'unit', label: word, render: m => h('span.mono.strong', { text: (store.db.get('units', m.unitId) || {}).code || '—' }) },
        { key: 'reason', label: 'Reason' },
        { key: 'startDate', label: 'Started', format: 'date' },
        { key: 'expectedEnd', label: 'Expected done', format: 'date' },
        { key: 'notes', label: 'Notes' },
        { key: 'act', label: '', render: m => store.session.can('maintenance.manage')
            ? h('button.btn.btn--sm.btn--primary', { type: 'button', text: 'Mark done',
                onclick: async () => {
                  const go = await confirm({ title: 'Finish this maintenance?',
                    message: 'The unit goes back into the cleaning cycle and can be sold again once clean.',
                    confirmLabel: 'Mark done' });
                  if (!go) return;
                  try { await hkApi.closeMaintenance(store, m.id); toastOk('Maintenance closed'); }
                  catch (err) { fail(err); }
                } })
            : null }
      ],
      rows: openMaint
    })) : null,

    filterBar([
      filterSelect('Status', state.hkStatus,
        [{ value: '', label: 'All' }].concat(HK_STATUS.map(s => ({ value: s.id, label: s.label }))),
        v => { state.hkStatus = v; app.refresh(); }),
      filterSelect('Floor', state.floor,
        [{ value: '', label: 'All floors' }].concat(floorsOf(store).map(f => ({ value: f, label: f }))),
        v => { state.floor = v; app.refresh(); }),
      state.hkStatus || state.floor
        ? h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Clear',
            onclick: () => { state.hkStatus = state.floor = ''; app.refresh(); } }) : null,
      h('span.push', segmented({ options: [{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }],
        value: state.view, onChange: v => { state.view = v; app.refresh(); } }))
    ]),

    rows.length
      ? (state.view === 'board' ? boardView(ctx, rows) : listView(ctx, rows))
      : card({}, emptyState({ title: 'Nothing matches these filters' })),

    card({ title: 'Recent housekeeping activity', flush: true }, dataTable({
      compact: true,
      columns: [
        { key: 'unitCode', label: word, render: t => h('span.mono', { text: t.unitCode || (store.db.get('units', t.unitId) || {}).code || '—' }) },
        { key: 'status', label: 'Status', render: t => hkBadge(t.status) },
        { key: 'source', label: 'Raised by', render: t => t.source === 'checkout' ? 'Check-out' : 'Manual' },
        { key: 'createdAt', label: 'Raised', format: 'datetime' },
        { key: 'completedAt', label: 'Finished', render: t => t.completedAt ? formatDateTime(t.completedAt) : '—' },
        { key: 'by', label: 'By', render: t => (store.db.get('users', t.completedBy || t.assignedTo) || {}).name || '—' }
      ],
      rows: hkApi.tasks(store).slice(0, 25),
      empty: emptyState({ title: 'No housekeeping activity yet' })
    }))
  ];
}

function boardView(ctx, rows) {
  const { store } = ctx;
  const groups = [
    { id: 'dirty', label: 'Needs cleaning' },
    { id: 'cleaning', label: 'Being cleaned' },
    { id: 'clean', label: 'Clean' },
    { id: 'inspected', label: 'Inspected' }
  ];
  return h('div.split.split--auto', groups.map(g => {
    const list = rows.filter(r => r.unit.hkStatus === g.id);
    return card({ title: g.label, note: String(list.length) },
      list.length
        ? h('div.stack.stack--sm', list.map(r => unitRow(ctx, r)))
        : h('div.text-sm.text-muted', { text: 'Nothing here.' }));
  }));
}

function unitRow(ctx, row) {
  const { store } = ctx;
  const unit = row.unit;
  const actions = store.session.can('housekeeping.update') && unit.status !== 'occupied'
    ? hkApi.nextHkStates(unit.hkStatus).map(s => h('button.btn.btn--sm', {
        type: 'button', text: (HK_STATUS.find(x => x.id === s) || {}).label,
        onclick: async () => {
          try { await hkApi.setHkStatus(store, unit.id, s); toastOk('Updated', `${unit.code} → ${s}`); }
          catch (err) { fail(err); }
        }
      }))
    : [];

  return h('div', { style: { padding: '9px 0', borderBottom: '1px solid var(--line-soft)' } }, [
    h('div.row', [
      h('span.mono.strong', { style: { fontSize: '15px' }, text: unit.code }),
      unit.status === 'occupied' ? badge('Occupied', 'river') : null,
      h('span.push.text-xs.text-muted', { text: unitTypeName(store, unit.unitTypeId) })
    ]),
    row.stay ? h('div.text-xs.text-muted', { style: { marginTop: '2px' },
      text: `${(store.db.get('guests', row.stay.guestId) || {}).fullName || ''} · out ${formatDate(row.stay.checkOut)}` }) : null,
    actions.length ? h('div.row.row--tight', { style: { marginTop: '6px' } }, actions) : null
  ]);
}

function listView(ctx, rows) {
  const { store } = ctx;
  const word = store.unitWord();
  return card({ flush: true }, dataTable({
    columns: [
      { key: 'code', label: word, render: r => h('span.mono.strong', { text: r.unit.code }) },
      { key: 'type', label: 'Type', render: r => unitTypeName(store, r.unit.unitTypeId) },
      { key: 'floor', label: 'Floor', render: r => r.unit.floor || '—' },
      { key: 'status', label: 'Sale status', render: r => unitBadge(r.unit.status) },
      { key: 'hk', label: 'Housekeeping', render: r => hkBadge(r.unit.hkStatus) },
      { key: 'guest', label: 'Guest', render: r => r.stay ? (store.db.get('guests', r.stay.guestId) || {}).fullName || '—' : '—' },
      { key: 'act', label: 'Move to', render: r => (store.session.can('housekeeping.update') && r.unit.status !== 'occupied')
          ? h('div.row.row--tight', hkApi.nextHkStates(r.unit.hkStatus).map(s => h('button.btn.btn--sm', {
              type: 'button', text: (HK_STATUS.find(x => x.id === s) || {}).label,
              onclick: async () => {
                try { await hkApi.setHkStatus(store, r.unit.id, s); toastOk('Updated', r.unit.code); }
                catch (err) { fail(err); }
              }
            })))
          : null }
    ],
    rows
  }));
}
