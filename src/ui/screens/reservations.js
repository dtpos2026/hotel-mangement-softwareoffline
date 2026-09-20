/**
 * Bookings list, booking detail and the booking form.
 *
 * The booking form is where the double-booking guard is visible to staff: the
 * unit list only offers units that are free for the chosen dates, and if a
 * clash is somehow still submitted, the domain refusal is shown in full with
 * the conflicting booking named.
 */

import { h, mount, qs, formValues, applyErrors, busy } from '../dom.js';
import { card, dataTable, emptyState, pageHead, reservationBadge, badge, moneyText,
         field, chipGroup, filterBar, filterSelect, segmented, alert, totalsRail, railRows, conflictList } from '../components.js';
import { modal, confirm, toast, ok as toastOk, fail, promptText } from '../feedback.js';
import { guestPicker, guestForm, paymentForm, chargeForm } from '../forms.js';
import * as reservationsApi from '../../domain/reservations.js';
import * as staysApi from '../../domain/stays.js';
import * as unitsApi from '../../domain/units.js';
import * as folioApi from '../../domain/folio.js';
import { quote } from '../../domain/pricing.js';
import { formatMoney, toMoney } from '../../core/money.js';
import { today, addDays, formatDate, formatDateTime, nightsBetween } from '../../core/dates.js';
import { BOOKING_SOURCES, PAYMENT_METHODS, RESERVATION_STATUS } from '../../core/schema.js';
import { printBill, printRegistrationCard } from '../print-actions.js';

const state = { status: '', from: '', to: '', q: '' };

export function render(ctx) {
  const { store, app, params } = ctx;

  if (params.action === 'new') { params.action = null; setTimeout(() => bookingForm(store, { onSaved: () => app.refresh() }), 0); }
  if (params.reservationId) {
    const r = store.db.get('reservations', params.reservationId);
    params.reservationId = null;
    if (r) setTimeout(() => bookingDetail(ctx, r), 0);
  }

  let list = reservationsApi.listReservations(store, { status: state.status || undefined });
  if (state.from) list = list.filter(r => r.checkOut > state.from);
  if (state.to) list = list.filter(r => r.checkIn <= state.to);
  if (state.q) {
    const q = state.q.toLowerCase();
    list = list.filter(r => {
      const g = store.db.get('guests', r.guestId);
      const u = store.db.get('units', r.unitId);
      return String(r.code).toLowerCase().indexOf(q) > -1
        || String(r.registerNo).toLowerCase().indexOf(q) > -1
        || (g && String(g.fullName).toLowerCase().indexOf(q) > -1)
        || (u && String(u.code).toLowerCase().indexOf(q) > -1);
    });
  }
  list = list.slice().reverse();

  return [
    pageHead('Bookings', 'بکنگ', [
      store.session.can('reservation.create')
        ? h('button.btn.btn--primary', { type: 'button', text: 'New booking',
            onclick: () => bookingForm(store, { onSaved: () => app.refresh() }) }) : null
    ]),

    filterBar([
      h('span.filters__label', { text: 'Status' }),
      filterSelect('', state.status,
        [{ value: '', label: 'All' }].concat(RESERVATION_STATUS.map(s => ({ value: s.id, label: s.label }))),
        v => { state.status = v; app.refresh(); }),
      h('input.input', { type: 'date', value: state.from, title: 'Staying on or after',
        onchange: e => { state.from = e.target.value; app.refresh(); } }),
      h('span.text-muted.text-sm', { text: 'to' }),
      h('input.input', { type: 'date', value: state.to, title: 'Staying on or before',
        onchange: e => { state.to = e.target.value; app.refresh(); } }),
      h('input.input', { placeholder: 'Find booking, guest or unit…', value: state.q, style: { minWidth: '200px' },
        oninput: e => { state.q = e.target.value; clearTimeout(render._t); render._t = setTimeout(() => app.refresh(), 200); } }),
      (state.status || state.from || state.to || state.q)
        ? h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Clear',
            onclick: () => { state.status = state.from = state.to = state.q = ''; app.refresh(); } }) : null,
      h('span.push.text-sm.text-muted', { text: `${list.length} booking(s)` })
    ]),

    card({ flush: true }, dataTable({
      currency: store.currency(),
      columns: [
        { key: 'code', label: 'Booking', render: r => h('span.mono.strong', { text: r.code }) },
        { key: 'guest', label: 'Guest', render: r => {
            const g = store.db.get('guests', r.guestId);
            return g ? g.fullName : '—';
          } },
        { key: 'unit', label: store.unitWord(), render: r => h('span.mono', { text: unitsApi.unitLabel(store, r.unitId) }) },
        { key: 'checkIn', label: 'Check-in', format: 'date' },
        { key: 'checkOut', label: 'Check-out', format: 'date' },
        { key: 'nights', label: 'Nt', align: 'end' },
        { key: 'pax', label: 'Pax', align: 'end', render: r => String((r.adults || 0) + (r.children || 0)) },
        { key: 'source', label: 'Source', render: r => (BOOKING_SOURCES.find(s => s.id === r.source) || {}).label || r.source },
        { key: 'status', label: 'Status', render: r => reservationBadge(r.status) },
        { key: 'total', label: 'Total', align: 'end', render: r => formatMoney(folioApi.billFor(store, r).total, store.currency()) },
        { key: 'balance', label: 'Balance', align: 'end', render: r => {
            const b = folioApi.billFor(store, r).balance;
            return moneyText(b, store.currency(), b > 0 ? 'due' : 'ok');
          } }
      ],
      rows: list,
      onRowClick: r => bookingDetail(ctx, r),
      empty: emptyState({
        title: 'No bookings yet',
        body: 'Create a booking in advance, or use Check In for a walk-in guest.',
        action: store.session.can('reservation.create')
          ? h('button.btn.btn--primary', { type: 'button', text: 'New booking',
              onclick: () => bookingForm(store, { onSaved: () => app.refresh() }) }) : null
      })
    }))
  ];
}

/* ---------------------------------------------------------- booking form */

/**
 * Create or edit a booking.
 *
 * Re-renders the unit list and the bill rail on every change to dates, unit,
 * guests or rate, so reception always sees the real price and the real
 * availability before saving.
 */
export function bookingForm(store, opts) {
  const o = opts || {};
  const editing = o.reservation || null;
  const currency = store.currency();
  const word = store.unitWord();
  const booking = store.setting('booking');

  const model = {
    guestId: editing ? editing.guestId : (o.guestId || ''),
    unitId: editing ? editing.unitId : (o.unitId || ''),
    checkIn: editing ? editing.checkIn : (o.checkIn || today()),
    checkOut: editing ? editing.checkOut : (o.checkOut || addDays(today(), booking.defaultNights || 1)),
    adults: editing ? editing.adults : 1,
    children: editing ? editing.children : 0,
    rate: editing ? (editing.rateSnapshot ? editing.rateSnapshot.base : editing.rate) : '',
    discount: editing ? editing.discount : 0,
    discountType: editing ? editing.discountType : 'amount',
    extraBeds: editing ? editing.extraBeds : 0,
    source: editing ? editing.source : 'phone',
    advance: 0,
    paymentMethod: 'cash',
    notes: editing ? editing.notes : '',
    comingFrom: editing ? editing.comingFrom : '',
    goingTo: editing ? editing.goingTo : '',
    vehicleNo: editing ? editing.vehicleNo : '',
    purpose: editing ? editing.purpose : 'Tourism',
    companions: editing ? (editing.companions || []).slice() : []
  };

  const guestBox = h('div');
  const unitBox = h('div');
  const billBox = h('div');
  const warnBox = h('div');
  const companionBox = h('div');

  const left = h('div.stack');
  const right = h('div.stack');

  /* --- guest ------------------------------------------------------------ */

  function renderGuest() {
    const guest = model.guestId ? store.db.get('guests', model.guestId) : null;
    mount(guestBox, guest
      ? h('div.row', { style: { justifyContent: 'space-between', gap: '10px' } }, [
          h('div', { style: { minWidth: 0 } }, [
            h('div.strong', { text: guest.fullName }),
            h('div.mono.text-xs.text-muted', { text: [guest.cnic, guest.phone, guest.city].filter(Boolean).join(' · ') || guest.code })
          ]),
          h('div.row.row--tight', [
            h('button.btn.btn--sm', { type: 'button', text: 'Change',
              onclick: () => guestPicker(store, g => { model.guestId = g.id; renderGuest(); }) }),
            h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Edit',
              onclick: () => guestForm(store, { guest, onSaved: () => renderGuest() }) })
          ])
        ])
      : h('div.row', { style: { gap: '8px' } }, [
          h('button.btn.btn--primary', { type: 'button', text: 'Choose guest',
            onclick: () => guestPicker(store, g => { model.guestId = g.id; renderGuest(); }) }),
          h('button.btn', { type: 'button', text: 'New guest',
            onclick: () => guestForm(store, { onSaved: g => { model.guestId = g.id; renderGuest(); } }) })
        ]));
  }

  /* --- units ------------------------------------------------------------ */

  function renderUnits() {
    const available = reservationsApi.availableUnits(store, model.checkIn, model.checkOut, {
      excludeId: editing ? editing.id : null,
      adults: model.adults, children: model.children
    });

    // Keep the current unit visible even if capacity filtering would drop it.
    const current = model.unitId ? store.db.get('units', model.unitId) : null;
    const list = current && !available.some(u => u.id === current.id) ? [current].concat(available) : available;

    if (model.unitId && !list.some(u => u.id === model.unitId)) model.unitId = '';

    mount(unitBox, list.length
      ? h('div.chips', list.map(u => {
          const free = reservationsApi.checkAvailability(store, u.id, model.checkIn, model.checkOut, editing ? editing.id : null);
          return h('button.chip', {
            type: 'button',
            class: u.id === model.unitId ? 'is-on' : null,
            style: free.available ? null : { borderColor: 'var(--due-line)', color: 'var(--due)' },
            title: free.available
              ? `${unitsApi.unitTypeName(store, u.unitTypeId)} · ${formatMoney(u.baseRate, currency)}`
              : free.reason,
            onclick: () => { model.unitId = u.id; if (model.rate === '') model.rate = ''; renderUnits(); renderBill(); }
          }, [
            h('span.mono.strong', { text: u.code }),
            h('span.text-xs', { style: { opacity: 0.7, marginInlineStart: '6px' },
              text: formatMoney(u.baseRate, currency) })
          ]);
        }))
      : alert('warn', `No ${word.toLowerCase()} is free for these dates`,
          'Change the dates, or free a unit by moving or cancelling an existing booking.'));
  }

  /* --- companions ------------------------------------------------------- */

  function renderCompanions() {
    mount(companionBox, h('div.stack.stack--sm', [
      model.companions.length
        ? h('div.stack.stack--sm', model.companions.map((c, i) =>
            h('div.row.row--tight', [
              h('input.input', { placeholder: 'Name', value: c.name || '', style: { flex: '2' },
                oninput: e => { model.companions[i].name = e.target.value; } }),
              h('input.input', { placeholder: 'Relation', value: c.relation || '', style: { flex: '1' },
                oninput: e => { model.companions[i].relation = e.target.value; } }),
              h('input.input', { placeholder: 'Age', value: c.age || '', style: { width: '72px' },
                oninput: e => { model.companions[i].age = e.target.value; } }),
              h('input.input.input--mono', { placeholder: 'CNIC (optional)', value: c.cnic || '', style: { flex: '1' },
                oninput: e => { model.companions[i].cnic = e.target.value; } }),
              h('button.btn.btn--sm.btn--ghost', { type: 'button', text: '×', title: 'Remove',
                onclick: () => { model.companions.splice(i, 1); renderCompanions(); } })
            ])))
        : h('div.text-sm.text-muted', { text: 'No accompanying guests recorded.' }),
      h('button.btn.btn--sm', { type: 'button', text: '+ Add person',
        onclick: () => { model.companions.push({ name: '', relation: '', age: '', cnic: '' }); renderCompanions(); } })
    ]));
  }

  /* --- bill ------------------------------------------------------------- */

  function renderBill() {
    const unit = model.unitId ? store.db.get('units', model.unitId) : null;
    const nights = nightsBetween(model.checkIn, model.checkOut);

    let q = null;
    if (unit && nights > 0) {
      q = quote(store, {
        unit, checkIn: model.checkIn, checkOut: model.checkOut,
        rate: model.rate === '' ? undefined : model.rate,
        extraBeds: model.extraBeds,
        discount: model.discount, discountType: model.discountType,
        advance: model.advance
      });
    }

    mount(billBox, q ? h('div.stack', [
      totalsRail([
        { label: `${word} charge — ${nights} night(s)`, value: q.room },
        q.extraBeds ? { label: `Extra bed × ${model.extraBeds}`, value: q.extraBeds } : null,
        q.discount ? { label: model.discountType === 'percent' ? `Discount ${model.discount}%` : 'Discount', value: -q.discount } : null,
        q.tax.enabled && q.taxAmount ? { label: `${q.tax.name} ${q.tax.percent}%`, value: q.taxAmount } : null,
        { label: 'Grand total', value: q.total, rule: true, kind: 'grand' },
        model.advance ? { label: 'Advance', value: q.advance } : null,
        { label: 'Balance', value: q.balance, rule: true, kind: q.balance > 0 ? 'balance' : 'settled' }
      ], currency),
      q.snapshot.weekendRate && q.snapshot.nights.some(n => n.weekend)
        ? h('div.text-xs.text-muted', { text: `Weekend nights priced at ${formatMoney(q.snapshot.weekendRate, currency)}.` })
        : null
    ]) : h('div.text-sm.text-muted', { text: `Choose a ${word.toLowerCase()} and dates to see the bill.` }));
  }

  /* --- availability warning --------------------------------------------- */

  function renderWarn() {
    if (!model.unitId) { mount(warnBox, null); return; }
    const result = reservationsApi.checkAvailability(store, model.unitId, model.checkIn, model.checkOut, editing ? editing.id : null);
    mount(warnBox, result.available ? null :
      alert('due', result.reason,
        result.conflicts.length ? 'This unit is already committed:' : '',
        conflictList(result.conflicts)));
  }

  const refresh = () => { renderUnits(); renderWarn(); renderBill(); };

  /* --- layout ----------------------------------------------------------- */

  mount(left, [
    card({ title: 'A · Guest' }, guestBox),

    card({ title: 'B · Stay' }, h('div.stack', [
      h('div.form-grid.form-grid--4', [
        field({ label: 'Check-in', name: 'checkIn', type: 'date', value: model.checkIn, required: true,
          onChange: e => {
            model.checkIn = e.target.value;
            if (model.checkOut <= model.checkIn) {
              model.checkOut = addDays(model.checkIn, 1);
              const el = qs('[name="checkOut"]', left); if (el) el.value = model.checkOut;
            }
            const n = qs('[name="nights"]', left); if (n) n.value = nightsBetween(model.checkIn, model.checkOut);
            refresh();
          } }),
        field({ label: 'Check-out', name: 'checkOut', type: 'date', value: model.checkOut, required: true,
          onChange: e => {
            model.checkOut = e.target.value;
            const n = qs('[name="nights"]', left); if (n) n.value = nightsBetween(model.checkIn, model.checkOut);
            refresh();
          } }),
        field({ label: 'Nights', name: 'nights', type: 'number', min: 1, value: nightsBetween(model.checkIn, model.checkOut),
          onChange: e => {
            const n = Math.max(1, Number(e.target.value) || 1);
            model.checkOut = addDays(model.checkIn, n);
            const el = qs('[name="checkOut"]', left); if (el) el.value = model.checkOut;
            refresh();
          } }),
        field({ label: 'Booking source', name: 'source', type: 'select', value: model.source,
          options: BOOKING_SOURCES.map(s => ({ value: s.id, label: s.label })),
          onChange: e => { model.source = e.target.value; } })
      ]),

      h('div.field', [
        h('div.field__label', { text: `${word} — available for these dates` }),
        unitBox
      ]),

      warnBox,

      h('div.form-grid.form-grid--4', [
        field({ label: 'Adults', name: 'adults', type: 'number', min: 1, value: model.adults,
          onChange: e => { model.adults = Number(e.target.value) || 1; refresh(); } }),
        field({ label: 'Children', name: 'children', type: 'number', min: 0, value: model.children,
          onChange: e => { model.children = Number(e.target.value) || 0; refresh(); } }),
        field({ label: 'Extra beds', name: 'extraBeds', type: 'number', min: 0, value: model.extraBeds,
          onChange: e => { model.extraBeds = Number(e.target.value) || 0; renderBill(); } }),
        field({ label: 'Rate per night', name: 'rate', type: 'number', min: 0, value: model.rate,
          hint: 'blank = unit rate', onInput: e => { model.rate = e.target.value; renderBill(); } })
      ]),

      h('div.form-grid.form-grid--4', [
        field({ label: 'Discount', name: 'discount', type: 'number', min: 0, value: model.discount,
          onInput: e => { model.discount = e.target.value; renderBill(); } }),
        field({ label: 'Discount type', name: 'discountType', type: 'select', value: model.discountType,
          options: [{ value: 'amount', label: 'Fixed amount' }, { value: 'percent', label: 'Percent' }],
          onChange: e => { model.discountType = e.target.value; renderBill(); } }),
        !editing ? field({ label: 'Advance received', name: 'advance', type: 'number', min: 0, value: model.advance,
          onInput: e => { model.advance = e.target.value; renderBill(); } }) : null,
        !editing ? field({ label: 'Payment method', name: 'paymentMethod', type: 'select', value: model.paymentMethod,
          options: PAYMENT_METHODS.map(m => ({ value: m.id, label: m.label })),
          onChange: e => { model.paymentMethod = e.target.value; } }) : null
      ])
    ])),

    card({ title: 'C · Register details', note: 'kept for the guest register' }, h('div.stack', [
      h('div.form-grid.form-grid--4', [
        field({ label: 'Coming from', name: 'comingFrom', value: model.comingFrom, placeholder: 'Islamabad',
          onInput: e => { model.comingFrom = e.target.value; } }),
        field({ label: 'Going to', name: 'goingTo', value: model.goingTo, placeholder: 'Kalam',
          onInput: e => { model.goingTo = e.target.value; } }),
        field({ label: 'Vehicle number', name: 'vehicleNo', mono: true, value: model.vehicleNo, placeholder: 'LEB-1234',
          onInput: e => { model.vehicleNo = e.target.value; } }),
        field({ label: 'Purpose', name: 'purpose', type: 'select', value: model.purpose,
          options: ['Tourism', 'Business', 'Family', 'Medical', 'Other'],
          onChange: e => { model.purpose = e.target.value; } })
      ]),
      field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2, value: model.notes,
        placeholder: 'Heater needed, arriving late', onInput: e => { model.notes = e.target.value; } })
    ])),

    card({ title: 'D · Accompanying persons' }, companionBox)
  ]);

  mount(right, card({ title: 'Bill summary' }, billBox));

  renderGuest();
  refresh();
  renderCompanions();

  const dialog = modal({
    title: editing ? `Edit booking ${editing.code}` : 'New booking',
    subtitle: editing ? null : 'The unit list only shows what is free for the chosen dates.',
    size: 'xwide',
    body: h('div.split.split--rail-sm', [left, right]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', {
        type: 'button', text: editing ? 'Save changes' : 'Save booking',
        onclick: e => busy(e.currentTarget, async () => {
          if (!model.guestId) { toast('warn', 'Choose a guest first', 'Every booking needs a guest profile.'); return; }
          if (!model.unitId) { toast('warn', `Choose a ${word.toLowerCase()}`, 'Pick one of the available units above.'); return; }
          try {
            let saved;
            if (editing) {
              saved = await reservationsApi.updateReservation(store, editing.id, {
                guestId: model.guestId, unitId: model.unitId,
                checkIn: model.checkIn, checkOut: model.checkOut,
                adults: model.adults, children: model.children,
                rate: model.rate === '' ? undefined : model.rate,
                discount: model.discount, discountType: model.discountType,
                extraBeds: model.extraBeds, source: model.source, notes: model.notes,
                comingFrom: model.comingFrom, goingTo: model.goingTo,
                vehicleNo: model.vehicleNo, purpose: model.purpose,
                companions: model.companions.filter(c => c.name)
              });
              toastOk('Booking updated', saved.code);
            } else {
              saved = await reservationsApi.createReservation(store, {
                guestId: model.guestId, unitId: model.unitId,
                checkIn: model.checkIn, checkOut: model.checkOut,
                adults: model.adults, children: model.children,
                rate: model.rate === '' ? undefined : model.rate,
                discount: model.discount, discountType: model.discountType,
                extraBeds: model.extraBeds, source: model.source, notes: model.notes,
                comingFrom: model.comingFrom, goingTo: model.goingTo,
                vehicleNo: model.vehicleNo, purpose: model.purpose,
                companions: model.companions.filter(c => c.name)
              });
              if (toMoney(model.advance) > 0) {
                const { recordPayment } = await import('../../domain/payments.js');
                await recordPayment(store, {
                  reservationId: saved.id, guestId: saved.guestId,
                  amount: model.advance, method: model.paymentMethod,
                  kind: 'advance', notes: 'Advance with booking'
                });
              }
              toastOk('Booking saved successfully.', `${saved.code} · ${formatDate(saved.checkIn)} → ${formatDate(saved.checkOut)}`);
            }
            dialog.close();
            if (o.onSaved) o.onSaved(saved);
          } catch (err) {
            if (err.code === 'DOUBLE_BOOKING' || err.code === 'UNIT_UNAVAILABLE') { refresh(); }
            fail(err);
          }
        })
      })
    ]
  });
  return dialog;
}

/* -------------------------------------------------------- booking detail */

export function bookingDetail(ctx, reservation) {
  const { store, app } = ctx;
  const currency = store.currency();
  const word = store.unitWord();

  const build = (dialog) => {
    const r = store.db.get('reservations', reservation.id) || reservation;
    const guest = store.db.get('guests', r.guestId);
    const unit = store.db.get('units', r.unitId);
    const bill = folioApi.billFor(store, r);

    dialog.body(h('div.split.split--rail-sm', [
      h('div.stack', [
        card({ title: 'Stay', tools: [reservationBadge(r.status)] }, railRows([
          { k: 'Booking no', v: r.code },
          r.registerNo ? { k: 'Register no', v: r.registerNo } : null,
          r.invoiceNo ? { k: 'Invoice no', v: r.invoiceNo } : null,
          { k: 'Guest', v: guest ? guest.fullName : '—' },
          guest && guest.phone ? { k: 'Phone', v: guest.phone } : null,
          guest && guest.cnic ? { k: 'CNIC', v: store.session.can('guest.viewCnic') ? guest.cnic : '•••••••' } : null,
          { k: word, v: unit ? unit.code : '—' },
          { k: 'Check-in', v: formatDate(r.checkIn) },
          { k: 'Check-out', v: formatDate(r.checkOut) },
          { k: 'Nights', v: String(r.nights) },
          { k: 'Guests', v: `${r.adults} adult(s), ${r.children} child(ren)` },
          { k: 'Source', v: (BOOKING_SOURCES.find(s => s.id === r.source) || {}).label || r.source },
          r.checkedInAt ? { k: 'Checked in', v: formatDateTime(r.checkedInAt) } : null,
          r.checkedOutAt ? { k: 'Checked out', v: formatDateTime(r.checkedOutAt) } : null,
          r.cancelReason ? { k: 'Cancel reason', v: r.cancelReason } : null,
          r.notes ? { k: 'Notes', v: r.notes } : null
        ])),

        (r.companions && r.companions.length) ? card({ title: 'Accompanying persons', flush: true },
          dataTable({ compact: true,
            columns: [{ key: 'name', label: 'Name' }, { key: 'relation', label: 'Relation' },
                      { key: 'age', label: 'Age', align: 'end' }, { key: 'cnic', label: 'CNIC' }],
            rows: r.companions })) : null,

        card({ title: 'Folio', flush: true, note: `${bill.lines.length} line(s)`,
          tools: (!r.invoiceNo && store.session.can('folio.add') && r.status !== 'cancelled')
            ? [h('button.btn.btn--sm', { type: 'button', text: '+ Add charge',
                onclick: () => chargeForm(store, { reservation: r, onSaved: () => build(dialog) }) })] : [] },
          dataTable({ currency, compact: true,
            columns: [
              { key: 'date', label: 'Date', format: 'date' },
              { key: 'description', label: 'Description' },
              { key: 'qty', label: 'Qty', align: 'end' },
              { key: 'rate', label: 'Rate', align: 'end', format: 'money' },
              { key: 'amount', label: 'Amount', align: 'end', format: 'money' }
            ],
            rows: bill.lines })),

        card({ title: 'Payments', flush: true, note: formatMoney(bill.paid, currency),
          tools: store.session.can('payment.create') && r.status !== 'cancelled'
            ? [h('button.btn.btn--sm', { type: 'button', text: '+ Payment',
                onclick: () => paymentForm(store, { reservation: r, onSaved: () => build(dialog) }) })] : [] },
          dataTable({ currency, compact: true,
            columns: [
              { key: 'code', label: 'Receipt' },
              { key: 'at', label: 'Date', format: 'datetime' },
              { key: 'method', label: 'Method', render: p => (PAYMENT_METHODS.find(m => m.id === p.method) || {}).label || p.method },
              { key: 'kind', label: 'Type' },
              { key: 'amount', label: 'Amount', align: 'end', format: 'money' }
            ],
            rows: bill.payments,
            empty: emptyState({ title: 'No payments yet' }) }))
      ]),

      h('div.stack', [
        card({ title: 'Bill' }, totalsRail([
          { label: 'Subtotal', value: bill.gross },
          bill.discount ? { label: bill.discountLabel, value: -bill.discount } : null,
          bill.taxAmount ? { label: `${bill.tax.name} ${bill.tax.percent}%`, value: bill.taxAmount } : null,
          { label: 'Grand total', value: bill.total, rule: true, kind: 'grand' },
          { label: 'Paid', value: bill.paid },
          { label: 'Balance', value: bill.balance, rule: true, kind: bill.balance > 0 ? 'balance' : 'settled' }
        ], currency)),

        bill.frozen ? alert('info', 'Invoice issued',
          `This stay was invoiced as ${bill.invoiceNo}. Its figures are frozen and will not change if prices change.`) : null,

        card({ title: 'Actions' }, h('div.stack.stack--sm', [
          r.status === 'reserved' && store.session.can('stay.checkin')
            ? h('button.btn.btn--primary.btn--block', { type: 'button', text: 'Check in',
                onclick: () => { dialog.close(); app.go('checkin', { reservationId: r.id }); } }) : null,
          r.status === 'checked_in' && store.session.can('stay.checkout')
            ? h('button.btn.btn--primary.btn--block', { type: 'button', text: 'Check out',
                onclick: () => { dialog.close(); app.go('checkout', { reservationId: r.id }); } }) : null,
          (r.status === 'reserved' || r.status === 'checked_in') && store.session.can('reservation.edit')
            ? h('button.btn.btn--block', { type: 'button', text: 'Edit booking',
                onclick: () => { dialog.close(); bookingForm(store, { reservation: r, onSaved: () => app.refresh() }); } }) : null,
          h('button.btn.btn--block', { type: 'button', text: 'Print bill (80mm)',
            onclick: () => printBill(store, r) }),
          h('button.btn.btn--block', { type: 'button', text: 'Print registration card (A4)',
            onclick: () => printRegistrationCard(store, r) }),
          r.status === 'reserved' && store.session.can('reservation.cancel')
            ? h('button.btn.btn--block', { type: 'button', text: 'Mark no-show',
                onclick: async () => {
                  const go = await confirm({ title: 'Mark as no-show?',
                    message: 'The dates are released immediately and the booking stays on record.', confirmLabel: 'Mark no-show' });
                  if (!go) return;
                  try { await reservationsApi.markNoShow(store, r.id); toastOk('Marked no-show', r.code); build(dialog); }
                  catch (err) { fail(err); }
                } }) : null,
          (r.status === 'reserved') && store.session.can('reservation.cancel')
            ? h('button.btn.btn--danger.btn--block', { type: 'button', text: 'Cancel booking',
                onclick: async () => {
                  const reason = await promptText({ title: `Cancel ${r.code}?`, label: 'Reason',
                    placeholder: 'Guest cancelled by phone', danger: true, confirmLabel: 'Cancel booking' });
                  if (reason === null) return;
                  try { await reservationsApi.cancelReservation(store, r.id, reason); toastOk('Booking cancelled', r.code); build(dialog); }
                  catch (err) { fail(err); }
                } }) : null
        ]))
      ])
    ]));
  };

  const dialog = modal({
    title: `Booking ${reservation.code}`,
    size: 'xwide',
    footer: [h('button.btn.btn--primary', { type: 'button', text: 'Close', onclick: () => dialog.close() })]
  });
  build(dialog);
  return dialog;
}
