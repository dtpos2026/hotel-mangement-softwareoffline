/**
 * Availability calendar (requirement 10).
 *
 * A unit-by-date timeline. Each cell is a day; a booking paints across the
 * nights it holds. Clicking a free cell starts a booking already primed with
 * that unit and date, which is how reception actually works from a wall chart.
 */

import { h } from '../dom.js';
import { card, pageHead, filterBar, filterSelect, segmented, emptyState } from '../components.js';
import { availabilityGrid } from '../../domain/reservations.js';
import { listUnitTypes, listUnits } from '../../domain/units.js';
import { today, addDays, startOfWeek, startOfMonth, endOfMonth, formatDate, parseDate, isWeekend, DAYS } from '../../core/dates.js';
import { bookingForm } from './reservations.js';

const state = { anchor: today(), span: 'month', typeId: '', unitId: '' };

export function render(ctx) {
  const { store, app } = ctx;
  const word = store.unitWord();

  const range = computeRange();
  const grid = availabilityGrid(store, range.from, range.to, { unitTypeId: state.typeId, unitId: state.unitId });
  const types = listUnitTypes(store);
  const units = listUnits(store);

  const head = pageHead('Availability calendar', 'دستیابی کیلنڈر', [
    h('button.btn', { type: 'button', text: '‹ Previous', onclick: () => { shift(-1); app.refresh(); } }),
    h('button.btn', { type: 'button', text: 'Today', onclick: () => { state.anchor = today(); app.refresh(); } }),
    h('button.btn', { type: 'button', text: 'Next ›', onclick: () => { shift(1); app.refresh(); } })
  ]);

  const filters = filterBar([
    h('span.filters__label', { text: 'View' }),
    segmented({
      options: [{ value: 'week', label: 'Week' }, { value: 'fortnight', label: '2 weeks' }, { value: 'month', label: 'Month' }],
      value: state.span, onChange: v => { state.span = v; app.refresh(); }
    }),
    filterSelect('Type', state.typeId, [{ value: '', label: 'All types' }].concat(types.map(t => ({ value: t.id, label: t.name }))),
      v => { state.typeId = v; state.unitId = ''; app.refresh(); }),
    filterSelect(word, state.unitId, [{ value: '', label: 'All ' + word.toLowerCase() + 's' }].concat(units.map(u => ({ value: u.id, label: u.code }))),
      v => { state.unitId = v; app.refresh(); }),
    h('span.push.row.row--tight', [
      legend('Available', 'var(--surface)', true),
      legend('Reserved', 'var(--accent)'),
      legend('Occupied', 'var(--river)'),
      legend('Maintenance', 'var(--muted)')
    ])
  ]);

  if (!grid.rows.length) {
    return [head, filters, card({}, emptyState({ title: 'Nothing to show',
      body: 'Add units, or clear the filters above.' }))];
  }

  return [
    head,
    h('div.text-sm.text-muted', { text: `${formatDate(range.from)} — ${formatDate(range.to)} · ${grid.rows.length} ${word.toLowerCase()}(s)` }),
    filters,
    card({ flush: true }, h('div.cal-wrap', calendarTable(ctx, grid, word))),
    summaryStrip(ctx, grid)
  ];
}

function legend(label, color, outline) {
  return h('span.row.row--tight', { style: { gap: '5px', fontSize: '11.5px', color: 'var(--muted)' } }, [
    h('span', { style: { width: '12px', height: '12px', borderRadius: '3px', background: color,
      border: outline ? '1px solid var(--line-strong)' : '0', display: 'inline-block' } }),
    label
  ]);
}

function computeRange() {
  if (state.span === 'week') {
    const from = startOfWeek(state.anchor);
    return { from, to: addDays(from, 6) };
  }
  if (state.span === 'fortnight') {
    const from = startOfWeek(state.anchor);
    return { from, to: addDays(from, 13) };
  }
  return { from: startOfMonth(state.anchor), to: endOfMonth(state.anchor) };
}

function shift(direction) {
  if (state.span === 'week') state.anchor = addDays(state.anchor, 7 * direction);
  else if (state.span === 'fortnight') state.anchor = addDays(state.anchor, 14 * direction);
  else {
    const d = parseDate(state.anchor);
    state.anchor = startOfMonth(new Date(d.getFullYear(), d.getMonth() + direction, 1, 12).toISOString().slice(0, 10));
  }
}

function calendarTable(ctx, grid, word) {
  const { store, app } = ctx;
  const weekendDays = store.setting('booking').weekendDays || [0, 6];
  const d0 = today();

  const headCells = grid.dates.map(date => {
    const d = parseDate(date);
    const weekend = isWeekend(date, weekendDays);
    return h('th.cal__day', { class: weekend ? 'is-weekend' : null,
      style: date === d0 ? { background: 'var(--accent-tint)', color: 'var(--accent)' } : null }, [
      DAYS[d.getDay()].slice(0, 2),
      h('span.cal__day-num', { text: String(d.getDate()) })
    ]);
  });

  const rows = grid.rows.map(row => {
    // A booking spans several days; render it once at its first visible cell
    // and skip the cells it covers, so the guest name is readable.
    const cells = [];
    let i = 0;
    while (i < row.cells.length) {
      const cell = row.cells[i];
      const weekend = isWeekend(cell.date, weekendDays);

      if (cell.state === 'available') {
        cells.push(h('td.cal__cell.cal__cell--available', {
          class: weekend ? 'is-weekend' : null,
          title: `${row.unit.code} · ${formatDate(cell.date)} · available`,
          onclick: store.session.can('reservation.create')
            ? () => bookingForm(store, { unitId: row.unit.id, checkIn: cell.date, checkOut: addDays(cell.date, 1), onSaved: () => app.refresh() })
            : null
        }));
        i++;
        continue;
      }

      let span = 1;
      while (i + span < row.cells.length &&
             row.cells[i + span].state === cell.state &&
             row.cells[i + span].reservationId === cell.reservationId) span++;

      cells.push(h('td.cal__cell', { colspan: span, title: `${row.unit.code} · ${cell.label}` },
        h('button.cal__pill.cal__pill--' + cell.state, {
          type: 'button',
          text: cell.label || cell.state,
          onclick: cell.reservationId ? () => app.go('reservations', { reservationId: cell.reservationId }) : null
        })));
      i += span;
    }

    return h('tr', [
      h('th.cal__unit', h('button', {
        type: 'button',
        style: { border: 0, background: 'transparent', padding: 0, textAlign: 'start', width: '100%' },
        onclick: () => app.go('units', { unitId: row.unit.id })
      }, [
        h('div.mono.strong', { text: row.unit.code }),
        h('div.text-xs.text-muted.truncate', { text: `${row.sold}/${row.cells.length} sold` })
      ]))
    ].concat(cells));
  });

  return h('table.cal', [
    h('thead', h('tr', [h('th.cal__unit', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }, text: word })].concat(headCells))),
    h('tbody', rows)
  ]);
}

function summaryStrip(ctx, grid) {
  const totalCells = grid.rows.reduce((s, r) => s + r.cells.length, 0) || 1;
  const sold = grid.rows.reduce((s, r) => s + r.sold, 0);
  return h('div.row', { style: { gap: '14px' } }, [
    h('span.text-sm.text-muted', { text: `Unit nights in view: ${totalCells}` }),
    h('span.text-sm', { text: `Sold: ${sold}` }),
    h('span.text-sm', { text: `Free: ${totalCells - sold}` }),
    h('span.text-sm.strong', { text: `Occupancy: ${Math.round(sold * 1000 / totalCells) / 10}%` })
  ]);
}
