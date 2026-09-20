/**
 * Unit board and unit management.
 *
 * Keeps the prototype's floor-sectioned board with its 4px status stripe and
 * sticky detail rail, and adds a list view, filters, and the management
 * actions the prototype only drew.
 */

import { h } from '../dom.js';
import { card, dataTable, emptyState, pageHead, unitBadge, hkBadge, badge, railRows, filterBar, filterSelect, segmented, moneyText, alert } from '../components.js';
import { confirm, ok as toastOk, fail } from '../feedback.js';
import { unitForm, unitTypeForm, maintenanceForm } from '../forms.js';
import * as unitsApi from '../../domain/units.js';
import { bedLayout } from '../../domain/units.js';
import * as hkApi from '../../domain/housekeeping.js';
import { billFor } from '../../domain/folio.js';
import { UNIT_STATUS, HK_STATUS } from '../../core/schema.js';
import { formatMoney } from '../../core/money.js';
import { formatDate, today } from '../../core/dates.js';
import { unitStatusColor } from '../components.js';

const state = { view: 'board', floor: '', typeId: '', status: '', selectedId: '', tab: 'units' };

export function render(ctx) {
  const { store, app, params } = ctx;
  const word = store.unitWord();

  if (params.status) { state.status = params.status; params.status = null; }
  if (params.unitId) { state.selectedId = params.unitId; params.unitId = null; }
  if (params.action === 'new') { params.action = null; setTimeout(() => unitForm(store, {}), 0); }

  const types = unitsApi.listUnitTypes(store);
  const units = unitsApi.listUnits(store, { floor: state.floor, unitTypeId: state.typeId, status: state.status });
  const allUnits = unitsApi.listUnits(store);
  const floors = unitsApi.floorsOf(store);

  if (!state.selectedId || !store.db.get('units', state.selectedId)) {
    state.selectedId = units.length ? units[0].id : '';
  }

  const head = pageHead(word + ' board', 'کمروں کی صورتحال', [
    store.session.can('unit.create')
      ? h('button.btn', { type: 'button', text: 'Unit types', onclick: () => showTypes(ctx) }) : null,
    store.session.can('maintenance.manage')
      ? h('button.btn', { type: 'button', text: 'Maintenance', onclick: () => maintenanceForm(store, { onSaved: () => app.refresh() }) }) : null,
    store.session.can('unit.create')
      ? h('button.btn.btn--primary', { type: 'button', text: 'Add ' + word.toLowerCase(),
          onclick: () => unitForm(store, { onSaved: u => { if (u) state.selectedId = u.id; app.refresh(); } }) }) : null
  ]);

  if (!allUnits.length) {
    return [head, card({}, emptyState({
      title: 'No ' + word.toLowerCase() + 's yet',
      body: `Start by creating a unit type (Deluxe Double, Cottage, Apartment…), then add the ${word.toLowerCase()}s that belong to it.`,
      action: store.session.can('unit.create')
        ? h('div.row', { style: { justifyContent: 'center' } }, [
            h('button.btn', { type: 'button', text: 'Add unit type', onclick: () => unitTypeForm(store, { onSaved: () => app.refresh() }) }),
            h('button.btn.btn--primary', { type: 'button', text: 'Add ' + word.toLowerCase(), onclick: () => unitForm(store, { onSaved: () => app.refresh() }) })
          ])
        : null
    }))];
  }

  const filters = filterBar([
    h('span.filters__label', { text: 'Filter' }),
    filterSelect('', state.floor, [{ value: '', label: 'All floors' }].concat(floors.map(f => ({ value: f, label: f }))),
      v => { state.floor = v; app.refresh(); }),
    filterSelect('', state.typeId, [{ value: '', label: 'All types' }].concat(types.map(t => ({ value: t.id, label: t.name }))),
      v => { state.typeId = v; app.refresh(); }),
    filterSelect('', state.status, [{ value: '', label: 'All statuses' }].concat(UNIT_STATUS.map(s => ({ value: s.id, label: s.label }))),
      v => { state.status = v; app.refresh(); }),
    (state.floor || state.typeId || state.status)
      ? h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Clear',
          onclick: () => { state.floor = state.typeId = state.status = ''; app.refresh(); } }) : null,
    h('span.push', segmented({
      options: [
        { value: 'board', label: 'Board' },
        { value: 'plan', label: 'Plan' },
        { value: 'list', label: 'List' }
      ],
      value: state.view, onChange: v => { state.view = v; app.refresh(); }
    }))
  ]);

  const selected = state.selectedId ? store.db.get('units', state.selectedId) : null;

  return [
    head,
    h('div.split.split--rail', [
      h('div.stack', [
        filters,
        units.length
          ? (state.view === 'board' ? boardView(ctx, units)
             : state.view === 'plan' ? planView(ctx, units)
             : listView(ctx, units))
          : card({}, emptyState({ title: 'No ' + word.toLowerCase() + ' matches these filters',
              action: h('button.btn', { type: 'button', text: 'Clear filters',
                onclick: () => { state.floor = state.typeId = state.status = ''; app.refresh(); } }) }))
      ]),
      selected ? detailRail(ctx, selected) : null
    ])
  ];
}

/* ------------------------------------------------------------------ views */

function boardView(ctx, units) {
  const byFloor = new Map();
  units.forEach(u => {
    const key = u.floor || 'Unassigned';
    if (!byFloor.has(key)) byFloor.set(key, []);
    byFloor.get(key).push(u);
  });

  const ordered = Array.from(byFloor.entries()).sort((a, b) => compareFloors(a[0], b[0]));

  return h('div', ordered.map(([floor, list]) => {
    const occ = list.filter(u => u.status === 'occupied').length;
    return h('section.card.board-section', [
      h('div.card__head', [
        h('h2.card__title', { text: floor }),
        h('span.card__note', { text: `${occ} of ${list.length} occupied` })
      ]),
      h('div.unit-grid', list.map(u => unitCard(ctx, u)))
    ]);
  }));
}

/**
 * Floors read in the order a person walks them, not alphabetically — so
 * "Ground, First, Second" rather than "First, Garden, Ground". Anything the
 * list does not know about sorts naturally after the named floors.
 */
const FLOOR_ORDER = ['basement', 'lower ground', 'ground', 'first', 'second', 'third',
                     'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

function floorRank(name) {
  const key = String(name || '').toLowerCase().replace(/\s*floor\s*/g, '').trim();
  const i = FLOOR_ORDER.indexOf(key);
  if (i > -1) return i;
  const numeric = /^(\d+)/.exec(key);
  if (numeric) return 100 + Number(numeric[1]);
  return 500;
}

export function compareFloors(a, b) {
  const ra = floorRank(a), rb = floorRank(b);
  if (ra !== rb) return ra - rb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function unitCard(ctx, unit) {
  const { store, app } = ctx;
  const stay = store.db.first('reservations', r => r.unitId === unit.id && r.status === 'checked_in');
  const held = !stay ? store.db.where('reservations', 'unitId', unit.id)
    .find(r => r.status === 'reserved' && r.checkIn <= today() && r.checkOut > today()) : null;
  const active = stay || held;
  const guest = active ? store.db.get('guests', active.guestId) : null;
  const bill = stay ? billFor(store, stay) : null;

  let detail = 'Ready to sell';
  let tone = '';
  if (stay) {
    const nights = Math.max(0, (new Date(stay.checkOut) - new Date(today())) / 86400000);
    detail = bill.balance > 0
      ? `${Math.round(nights)} night(s) left · ${formatMoney(bill.balance, store.currency())} due`
      : `${Math.round(nights)} night(s) left · settled`;
    tone = bill.balance > 0 ? 'due' : '';
  } else if (held) {
    detail = `Arriving ${formatDate(held.checkIn)}`;
  } else if (unit.status === 'cleaning') detail = 'Needs cleaning';
  else if (unit.status === 'maintenance') detail = 'Under maintenance';
  else if (unit.status === 'blocked') detail = 'Blocked';

  return h('button.unit-card', {
    type: 'button',
    class: unit.id === state.selectedId ? 'is-selected' : null,
    onclick: () => { state.selectedId = unit.id; app.refresh(); }
  }, [
    h('div.unit-card__stripe', { style: { background: unitStatusColor(unit.status) } }),
    h('div.unit-card__body', [
      h('div.unit-card__top', [
        h('span.unit-card__code', {
          class: unit.code.length > 10 ? 'unit-card__code--xlong' : unit.code.length > 5 ? 'unit-card__code--long' : null,
          title: unit.code, text: unit.code
        }),
        h('span.unit-card__status', { style: { color: unitStatusColor(unit.status) },
          text: (UNIT_STATUS.find(s => s.id === unit.status) || {}).label || unit.status })
      ]),
      h('div.unit-card__type', { text: unitsApi.unitTypeName(store, unit.unitTypeId) }),
      h('div.unit-card__guest', { text: guest ? guest.fullName : '—' }),
      h('div.unit-card__detail', { class: tone === 'due' ? 'money-due' : null, text: detail })
    ])
  ]);
}

/**
 * The plan view: every unit drawn with the beds it actually contains, grouped
 * by floor. It answers the question a receptionist asks on the phone — "how
 * many beds is that room?" — without opening anything.
 */
function planView(ctx, units) {
  const { store } = ctx;
  const byFloor = new Map();
  units.forEach(u => {
    const key = u.floor || 'Unassigned';
    if (!byFloor.has(key)) byFloor.set(key, []);
    byFloor.get(key).push(u);
  });
  const ordered = Array.from(byFloor.entries()).sort((a, b) => compareFloors(a[0], b[0]));

  return h('div', ordered.map(([floor, list]) => {
    const beds = list.reduce((n, u) => n + bedLayout(store, u).sleeps, 0);
    return h('section.card.board-section', [
      h('div.card__head', [
        h('h2.card__title', { text: floor }),
        h('span.card__note', { text: `${list.length} ${store.unitWord().toLowerCase()}(s) · ${beds} bed spaces` })
      ]),
      h('div.plan-grid', list.map(u => planCard(ctx, u)))
    ]);
  }));
}

function planCard(ctx, unit) {
  const { store, app } = ctx;
  const currency = store.currency();
  const layout = bedLayout(store, unit);
  const stay = store.db.first('reservations', r => r.unitId === unit.id && r.status === 'checked_in');
  const guest = stay ? store.db.get('guests', stay.guestId) : null;
  const bill = stay ? billFor(store, stay) : null;
  const cap = unitsApi.capacityOf(store, unit);

  return h('button.plan-card', {
    type: 'button',
    'data-status': unit.status,
    class: unit.id === state.selectedId ? 'is-selected' : null,
    title: `${unit.code} — ${layout.beds.map(b => b.label).join(' + ')}`,
    onclick: () => { state.selectedId = unit.id; app.refresh(); }
  }, [
    h('div.plan-card__head', [
      h('span.plan-card__code', { text: unit.code }),
      h('span.plan-card__status', { style: { color: unitStatusColor(unit.status) },
        text: (UNIT_STATUS.find(s => s.id === unit.status) || {}).label || unit.status })
    ]),
    h('div.plan-card__type', { text: unitsApi.unitTypeName(store, unit.unitTypeId) }),

    // The room itself, with its beds drawn to scale against each other.
    h('div.plan-room', layout.beds.map(bed =>
      h('div.plan-bed', { 'data-kind': bed.key, title: bed.label, style: { '--w': String(bed.width) } }, [
        h('span.plan-bed__pillow'),
        h('span.plan-bed__label', { text: bed.short })
      ]))),

    h('div.plan-card__beds', [
      h('span', { text: layout.beds.length + ' bed' + (layout.beds.length === 1 ? '' : 's') }),
      h('span.plan-card__sleeps', { text: 'sleeps ' + layout.sleeps }),
      layout.inferred ? h('span.plan-card__guess', { title: 'No bed configuration is recorded, so this is worked out from the capacity.', text: '?' }) : null
    ]),

    h('div.plan-card__foot', guest
      ? [h('span.truncate', { text: guest.fullName }),
         bill && bill.balance > 0 ? h('span.money-due.mono', { text: formatMoney(bill.balance, currency) }) : null]
      : [h('span.text-muted', { text: `${cap.adults} adult${cap.adults === 1 ? '' : 's'}` }),
         h('span.mono', { text: formatMoney(unit.baseRate, currency) })])
  ]);
}

function listView(ctx, units) {
  const { store, app } = ctx;
  const word = store.unitWord();
  return card({ flush: true }, dataTable({
    currency: store.currency(),
    selectedId: state.selectedId,
    columns: [
      { key: 'code', label: word, render: u => h('span.mono.strong', { text: u.code }) },
      { key: 'type', label: 'Type', render: u => unitsApi.unitTypeName(store, u.unitTypeId) },
      { key: 'floor', label: 'Floor' },
      { key: 'cap', label: 'Capacity', align: 'end', render: u => `${u.capacityAdults}+${u.capacityChildren}` },
      { key: 'baseRate', label: 'Base rate', align: 'end', format: 'money' },
      { key: 'weekendRate', label: 'Weekend', align: 'end', render: u => u.weekendRate ? formatMoney(u.weekendRate, store.currency()) : '—' },
      { key: 'status', label: 'Status', render: u => unitBadge(u.status) },
      { key: 'hkStatus', label: 'Housekeeping', render: u => hkBadge(u.hkStatus) },
      { key: 'act', label: '', render: u => store.session.can('unit.edit')
          ? h('button.btn.btn--sm', { type: 'button', text: 'Edit',
              onclick: () => unitForm(store, { unit: u, onSaved: () => app.refresh() }) })
          : null }
    ],
    rows: units,
    onRowClick: u => { state.selectedId = u.id; app.refresh(); }
  }));
}

/* ------------------------------------------------------------ detail rail */

function detailRail(ctx, unit) {
  const { store, app } = ctx;
  const word = store.unitWord();
  const currency = store.currency();
  const stay = store.db.first('reservations', r => r.unitId === unit.id && r.status === 'checked_in');
  const guest = stay ? store.db.get('guests', stay.guestId) : null;
  const bill = stay ? billFor(store, stay) : null;
  const upcoming = store.db.where('reservations', 'unitId', unit.id)
    .filter(r => r.status === 'reserved' && r.checkOut > today())
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn)).slice(0, 3);
  const openMaint = store.db.all('maintenance').filter(m => m.unitId === unit.id && m.status === 'open');
  const type = store.db.get('unitTypes', unit.unitTypeId);

  const actions = [];
  if (stay && store.session.can('stay.checkout')) {
    actions.push(h('button.btn.btn--primary', { type: 'button', text: 'Check out',
      onclick: () => app.go('checkout', { reservationId: stay.id }) }));
  }
  if (!stay && unit.status === 'available' && store.session.can('stay.checkin')) {
    actions.push(h('button.btn.btn--primary', { type: 'button', text: 'Walk-in',
      onclick: () => app.go('checkin', { unitId: unit.id }) }));
  }
  if (store.session.can('housekeeping.update') && unit.status !== 'occupied') {
    const next = hkApi.nextHkStates(unit.hkStatus);
    next.slice(0, 2).forEach(s => actions.push(h('button.btn', {
      type: 'button', text: 'Mark ' + (HK_STATUS.find(x => x.id === s) || {}).label,
      onclick: async () => {
        try { await hkApi.setHkStatus(store, unit.id, s); toastOk('Housekeeping updated', `${unit.code} → ${s}`); }
        catch (err) { fail(err); }
      }
    })));
  }
  if (store.session.can('maintenance.manage')) {
    if (openMaint.length) {
      actions.push(h('button.btn', { type: 'button', text: 'End maintenance',
        onclick: async () => {
          try { await hkApi.closeMaintenance(store, openMaint[0].id); toastOk('Maintenance closed', unit.code); }
          catch (err) { fail(err); }
        } }));
    } else if (unit.status !== 'occupied') {
      actions.push(h('button.btn', { type: 'button', text: 'Maintenance',
        onclick: () => maintenanceForm(store, { unitId: unit.id, onSaved: () => app.refresh() }) }));
      actions.push(h('button.btn', { type: 'button', text: unit.status === 'blocked' ? 'Unblock' : 'Block',
        onclick: async () => {
          try {
            await unitsApi.setUnitStatus(store, unit.id, unit.status === 'blocked' ? 'available' : 'blocked');
            toastOk('Updated', unit.code);
          } catch (err) { fail(err); }
        } }));
    }
  }
  if (store.session.can('unit.edit')) {
    actions.push(h('button.btn', { type: 'button', text: 'Edit ' + word.toLowerCase(),
      onclick: () => unitForm(store, { unit, onSaved: () => app.refresh() }) }));
  }

  return h('aside.rail', card({
    title: `${word} ${unit.code}`,
    tools: [unitBadge(unit.status)]
  }, [
    openMaint.length ? alert('warn', 'Under maintenance',
      `${openMaint[0].reason} · since ${formatDate(openMaint[0].startDate)}`) : null,

    railRows([
      { k: 'Type', v: type ? type.name : '—' },
      { k: 'Floor', v: unit.floor || '—' },
      { k: 'Capacity', v: `${unit.capacityAdults} adults, ${unit.capacityChildren} children` },
      unit.bedConfig ? { k: 'Beds', v: unit.bedConfig } : null,
      { k: 'Base rate', v: formatMoney(unit.baseRate, currency) },
      unit.weekendRate ? { k: 'Weekend rate', v: formatMoney(unit.weekendRate, currency) } : null,
      { k: 'Housekeeping', node: hkBadge(unit.hkStatus) },
      { k: 'Guest', v: guest ? guest.fullName : '—' },
      stay ? { k: 'Stay', v: `${stay.code} · ${formatDate(stay.checkIn)} → ${formatDate(stay.checkOut)}` } : null,
      stay ? { k: 'Balance', node: moneyText(bill.balance, currency, bill.balance > 0 ? 'due' : 'ok') } : null
    ]),

    (unit.amenities && unit.amenities.length)
      ? h('div', { style: { marginTop: '12px' } }, [
          h('div.field__label', { text: 'Amenities' }),
          h('div.row.row--tight', { style: { marginTop: '5px' } }, unit.amenities.map(a => badge(a, 'muted')))
        ]) : null,

    upcoming.length ? h('div', { style: { marginTop: '14px' } }, [
      h('div.field__label', { text: 'Upcoming bookings' }),
      h('div.stack.stack--sm', { style: { marginTop: '6px' } }, upcoming.map(r => {
        const g = store.db.get('guests', r.guestId);
        return h('button.btn.btn--sm.btn--block', {
          type: 'button', style: { justifyContent: 'space-between' },
          onclick: () => app.go('reservations', { reservationId: r.id })
        }, [
          h('span.truncate', { text: g ? g.fullName : r.code }),
          h('span.mono.text-xs', { text: formatDate(r.checkIn) })
        ]);
      }))
    ]) : null,

    actions.length ? h('div', { style: { marginTop: '14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } }, actions) : null
  ]));
}

/* ------------------------------------------------------------- unit types */

function showTypes(ctx) {
  const { store, app } = ctx;
  import('../feedback.js').then(({ modal }) => {
    const build = (dialog) => {
      const types = unitsApi.listUnitTypes(store);
      dialog.body(types.length ? dataTable({
        currency: store.currency(), compact: true,
        columns: [
          { key: 'name', label: 'Type' },
          { key: 'capacityAdults', label: 'Adults', align: 'end' },
          { key: 'capacityChildren', label: 'Children', align: 'end' },
          { key: 'defaultRate', label: 'Default rate', align: 'end', format: 'money' },
          { key: 'weekendRate', label: 'Weekend', align: 'end', render: t => t.weekendRate ? formatMoney(t.weekendRate, store.currency()) : '—' },
          { key: 'used', label: 'Units', align: 'end', render: t => String(unitsApi.unitTypeUsage(store, t.id).units) },
          { key: 'act', label: '', render: t => h('div.row.row--tight', [
              h('button.btn.btn--sm', { type: 'button', text: 'Edit',
                onclick: () => unitTypeForm(store, { unitType: t, onSaved: () => { build(dialog); app.refresh(); } }) }),
              h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Archive',
                onclick: async () => {
                  const go = await confirm({ title: `Archive ${t.name}?`,
                    message: 'It will no longer be offered for new units. Existing units and bookings keep it.', danger: true, confirmLabel: 'Archive' });
                  if (!go) return;
                  try { await unitsApi.archiveUnitType(store, t.id); toastOk('Type archived', t.name); build(dialog); app.refresh(); }
                  catch (err) { fail(err); }
                } })
            ]) }
        ],
        rows: types
      }) : emptyState({ title: 'No unit types yet', body: 'A unit type is a reusable template: Deluxe Double, Family Suite, Cottage, Apartment, Shared Bed.' }));
    };

    const dialog = modal({
      title: 'Unit types',
      subtitle: 'Reusable templates that supply default rates and capacity.',
      size: 'wide',
      footer: [
        h('button.btn', { type: 'button', text: 'Close', onclick: () => dialog.close() }),
        h('button.btn.btn--primary', { type: 'button', text: 'New type',
          onclick: () => unitTypeForm(store, { onSaved: () => { build(dialog); app.refresh(); } }) })
      ]
    });
    build(dialog);
  });
}
