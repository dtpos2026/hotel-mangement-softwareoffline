/**
 * Check-in — the busiest screen at the desk.
 *
 * Two paths on one page:
 *   · Today's arrivals, one click to check a booked guest in.
 *   · The walk-in form, which creates the guest, the booking, the check-in and
 *     the advance receipt in a single save (requirement 11).
 *
 * The form keeps the prototype's A / B / C shape and its live bill rail.
 */

import { h, mount, qs, busy } from '../dom.js';
import { card, dataTable, pageHead, field, chipGroup, alert, totalsRail, conflictList } from '../components.js';
import { toast, ok as toastOk, fail, modal } from '../feedback.js';
import { guestPicker } from '../forms.js';
import * as reservationsApi from '../../domain/reservations.js';
import * as staysApi from '../../domain/stays.js';
import * as unitsApi from '../../domain/units.js';
import * as guestsApi from '../../domain/guests.js';
import * as folioApi from '../../domain/folio.js';
import { quote } from '../../domain/pricing.js';
import { formatMoney } from '../../core/money.js';
import { today, addDays, formatDate, nightsBetween } from '../../core/dates.js';
import { formatCnic, formatPhone } from '../../core/validate.js';
import { BOOKING_SOURCES, PAYMENT_METHODS } from '../../core/schema.js';
import { printCheckInSlip } from '../print-actions.js';

export function render(ctx) {
  const { store, app, params } = ctx;
  const word = store.unitWord();
  const currency = store.currency();
  const booking = store.setting('booking');

  if (params.reservationId) {
    const r = store.db.get('reservations', params.reservationId);
    params.reservationId = null;
    if (r && r.status === 'reserved') setTimeout(() => checkInDialog(ctx, r), 0);
  }

  const arrivals = reservationsApi.arrivalsOn(store, today()).filter(r => r.status === 'reserved');
  const earlier = reservationsApi.listReservations(store, { status: 'reserved' })
    .filter(r => r.checkIn < today());

  /* ------------------------------------------------------- walk-in model */

  const model = {
    guestId: '',
    unitId: params.unitId || '',
    checkIn: today(),
    checkOut: addDays(today(), booking.defaultNights || 1),
    adults: 1, children: 0, extraBeds: 0,
    rate: '', discount: 0, discountType: 'amount',
    advance: '', paymentMethod: 'cash', source: 'walkin',
    comingFrom: '', goingTo: '', vehicleNo: '', purpose: 'Tourism', notes: '',
    companions: []
  };
  params.unitId = null;

  const guestBox = h('div');
  const unitBox = h('div');
  const billBox = h('div');
  const warnBox = h('div');
  const companionBox = h('div');
  const methodBox = h('div');
  const root = h('div.stack');

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
            h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Clear',
              onclick: () => { model.guestId = ''; renderGuest(); } })
          ])
        ])
      : h('div.stack', [
          h('div.form-grid.form-grid--4', [
            field({ label: 'Full name', name: 'fullName', required: true, placeholder: 'Muhammad Bilal', span: 2, autofocus: true }),
            field({ label: 'CNIC', name: 'cnic', mono: true, placeholder: '15302-1234567-1',
              required: booking.requireCnic, onInput: e => { e.target.value = formatCnic(e.target.value); } }),
            field({ label: 'Phone', name: 'phone', mono: true, placeholder: '0300-1234567',
              onInput: e => { e.target.value = formatPhone(e.target.value); },
              onBlur: e => lookupExisting(e.target.value) }),
            field({ label: 'Father / husband name', name: 'fatherName', placeholder: 'Abdul Rahman' }),
            field({ label: 'Address', name: 'address', placeholder: 'House 4, Gulberg' }),
            field({ label: 'City', name: 'city', placeholder: 'Lahore' }),
            field({ label: 'Country', name: 'country', value: 'Pakistan' })
          ]),
          h('div.row', [
            h('button.btn.btn--sm', { type: 'button', text: 'Find an existing guest instead',
              onclick: () => guestPicker(store, g => { model.guestId = g.id; renderGuest(); }) }),
            h('span.text-xs.text-muted', { text: 'A returning guest keeps one profile — no duplicates.' })
          ])
        ]));
  }

  /** Typing a known phone number offers the existing profile straight away. */
  function lookupExisting(phone) {
    if (model.guestId || !phone) return;
    const match = guestsApi.findMatch(store, { phone });
    if (!match) return;
    toast('info', `${match.guest.fullName} is already on file`,
      'Matched on phone. Click "Find an existing guest instead" to reuse the profile.');
  }

  function renderUnits() {
    const available = reservationsApi.availableUnits(store, model.checkIn, model.checkOut, {
      adults: model.adults, children: model.children
    });
    if (model.unitId && !available.some(u => u.id === model.unitId)) model.unitId = '';

    mount(unitBox, available.length
      ? h('div.chips', available.map(u => h('button.chip', {
          type: 'button',
          class: u.id === model.unitId ? 'is-on' : null,
          title: `${unitsApi.unitTypeName(store, u.unitTypeId)} · ${u.floor || ''}`,
          onclick: () => { model.unitId = u.id; renderUnits(); renderBill(); }
        }, [
          h('span.mono.strong', { text: u.code }),
          h('span.text-xs', { style: { opacity: 0.7, marginInlineStart: '6px' }, text: formatMoney(u.baseRate, currency) })
        ])))
      : alert('warn', `Nothing is free for these dates`,
          `Every ${word.toLowerCase()} is taken, blocked or under maintenance for ${formatDate(model.checkIn)} → ${formatDate(model.checkOut)}.`));
  }

  function renderMethods() {
    mount(methodBox, chipGroup({
      options: PAYMENT_METHODS.map(m => ({ value: m.id, label: m.label })),
      value: model.paymentMethod,
      onChange: v => { model.paymentMethod = v; renderMethods(); }
    }));
  }

  function renderCompanions() {
    mount(companionBox, h('div.stack.stack--sm', [
      model.companions.length
        ? h('div.stack.stack--sm', model.companions.map((c, i) => h('div.row.row--tight', [
            h('input.input', { placeholder: 'Name', value: c.name || '', style: { flex: '2' },
              oninput: e => { model.companions[i].name = e.target.value; } }),
            h('input.input', { placeholder: 'Relation', value: c.relation || '', style: { flex: '1' },
              oninput: e => { model.companions[i].relation = e.target.value; } }),
            h('input.input', { placeholder: 'Age', value: c.age || '', style: { width: '70px' },
              oninput: e => { model.companions[i].age = e.target.value; } }),
            h('input.input.input--mono', { placeholder: 'CNIC (optional)', value: c.cnic || '', style: { flex: '1' },
              oninput: e => { model.companions[i].cnic = e.target.value; } }),
            h('button.btn.btn--sm.btn--ghost', { type: 'button', text: '×',
              onclick: () => { model.companions.splice(i, 1); renderCompanions(); } })
          ])))
        : h('div.text-sm.text-muted', { text: 'None recorded.' }),
      h('button.btn.btn--sm', { type: 'button', text: '+ Add person',
        onclick: () => { model.companions.push({ name: '', relation: '', age: '', cnic: '' }); renderCompanions(); } })
    ]));
  }

  function renderBill() {
    const unit = model.unitId ? store.db.get('units', model.unitId) : null;
    const nights = nightsBetween(model.checkIn, model.checkOut);
    if (!unit || nights < 1) {
      mount(billBox, h('div.text-sm.text-muted', { text: `Choose a ${word.toLowerCase()} to see the bill.` }));
      return;
    }
    const q = quote(store, {
      unit, checkIn: model.checkIn, checkOut: model.checkOut,
      rate: model.rate === '' ? undefined : model.rate,
      extraBeds: model.extraBeds, discount: model.discount, discountType: model.discountType,
      advance: model.advance
    });
    mount(billBox, totalsRail([
      { label: `${word} charge — ${nights} night(s)`, value: q.room },
      q.extraBeds ? { label: `Extra bed × ${model.extraBeds}`, value: q.extraBeds } : null,
      q.discount ? { label: 'Discount', value: -q.discount } : null,
      q.taxAmount ? { label: `${q.tax.name} ${q.tax.percent}%`, value: q.taxAmount } : null,
      { label: 'Grand total', value: q.total, rule: true, kind: 'grand' },
      { label: 'Advance', value: q.advance },
      { label: 'Balance', value: q.balance, rule: true, kind: q.balance > 0 ? 'balance' : 'settled' }
    ], currency));
  }

  function renderWarn() {
    if (!model.unitId) { mount(warnBox, null); return; }
    const result = reservationsApi.checkAvailability(store, model.unitId, model.checkIn, model.checkOut);
    mount(warnBox, result.available ? null
      : alert('due', result.reason, result.conflicts.length ? 'Already committed to:' : '', conflictList(result.conflicts)));
  }

  const refresh = () => { renderUnits(); renderWarn(); renderBill(); };

  /* -------------------------------------------------------------- submit */

  async function save(printAfter, buttonEl) {
    return busy(buttonEl, async () => {
      let guestData = null;
      if (!model.guestId) {
        const form = qs('#walkinGuest', root);
        guestData = {
          fullName: (qs('[name="fullName"]', form) || {}).value || '',
          cnic: (qs('[name="cnic"]', form) || {}).value || '',
          phone: (qs('[name="phone"]', form) || {}).value || '',
          fatherName: (qs('[name="fatherName"]', form) || {}).value || '',
          address: (qs('[name="address"]', form) || {}).value || '',
          city: (qs('[name="city"]', form) || {}).value || '',
          country: (qs('[name="country"]', form) || {}).value || 'Pakistan'
        };
        if (!guestData.fullName.trim()) {
          toast('warn', 'Guest name is required', 'Enter the name, or pick an existing guest.');
          const el = qs('[name="fullName"]', form); if (el) el.focus();
          return;
        }
      }
      if (!model.unitId) {
        toast('warn', `Choose a ${word.toLowerCase()}`, 'Pick one of the available units.');
        return;
      }

      try {
        const result = await staysApi.walkIn(store, {
          guestId: model.guestId || undefined,
          guest: guestData || undefined,
          unitId: model.unitId,
          checkIn: model.checkIn, checkOut: model.checkOut,
          adults: model.adults, children: model.children,
          extraBeds: model.extraBeds,
          rate: model.rate === '' ? undefined : model.rate,
          discount: model.discount, discountType: model.discountType,
          advance: model.advance, paymentMethod: model.paymentMethod,
          source: model.source, notes: model.notes,
          comingFrom: model.comingFrom, goingTo: model.goingTo,
          vehicleNo: model.vehicleNo, purpose: model.purpose,
          companions: model.companions.filter(c => c.name)
        });
        toastOk('Guest checked in.', `${result.guest.fullName} · ${unitsApi.unitLabel(store, model.unitId)} · ${result.reservation.code}`);
        if (printAfter) printCheckInSlip(store, result.reservation);
        app.refresh();
      } catch (err) {
        fail(err);
        refresh();
      }
    });
  }

  /* -------------------------------------------------------------- layout */

  mount(root, [
    pageHead('Check in guest', 'مہمان کی آمد', [
      h('button.btn', { type: 'button', text: 'New booking instead',
        onclick: () => import('./reservations.js').then(m => m.bookingForm(store, { onSaved: () => app.refresh() })) })
    ]),

    (arrivals.length || earlier.length) ? card({
      title: 'Expected arrivals',
      note: `${arrivals.length} today${earlier.length ? ` · ${earlier.length} overdue` : ''}`,
      flush: true
    }, dataTable({
      currency, compact: true,
      columns: [
        { key: 'code', label: 'Booking', render: r => h('span.mono', { text: r.code }) },
        { key: 'guest', label: 'Guest', render: r => (store.db.get('guests', r.guestId) || {}).fullName || '—' },
        { key: 'phone', label: 'Phone', render: r => h('span.mono.text-sm', { text: (store.db.get('guests', r.guestId) || {}).phone || '—' }) },
        { key: 'unit', label: word, render: r => h('span.mono.strong', { text: unitsApi.unitLabel(store, r.unitId) }) },
        { key: 'checkIn', label: 'Arriving', render: r => h('span', {
            class: r.checkIn < today() ? 'money-due' : null, text: formatDate(r.checkIn) }) },
        { key: 'nights', label: 'Nt', align: 'end' },
        { key: 'pax', label: 'Pax', align: 'end', render: r => String(r.adults + r.children) },
        { key: 'total', label: 'Bill', align: 'end', render: r => formatMoney(folioApi.billFor(store, r).total, currency) },
        { key: 'act', label: '', render: r => h('button.btn.btn--sm.btn--primary', {
            type: 'button', text: 'Check in', onclick: () => checkInDialog(ctx, r) }) }
      ],
      rows: earlier.concat(arrivals)
    })) : null,

    h('div.split.split--rail', [
      h('div.stack', [
        card({ title: 'A · Guest details', note: 'walk-in' }, h('div', { id: 'walkinGuest' }, guestBox)),

        card({ title: 'B · Stay details' }, h('div.stack', [
          h('div.form-grid.form-grid--4', [
            field({ label: 'Check-in', name: 'wCheckIn', type: 'date', value: model.checkIn,
              onChange: e => {
                model.checkIn = e.target.value;
                if (model.checkOut <= model.checkIn) {
                  model.checkOut = addDays(model.checkIn, 1);
                  const el = qs('[name="wCheckOut"]', root); if (el) el.value = model.checkOut;
                }
                const n = qs('[name="wNights"]', root); if (n) n.value = nightsBetween(model.checkIn, model.checkOut);
                refresh();
              } }),
            field({ label: 'Check-out', name: 'wCheckOut', type: 'date', value: model.checkOut,
              onChange: e => {
                model.checkOut = e.target.value;
                const n = qs('[name="wNights"]', root); if (n) n.value = nightsBetween(model.checkIn, model.checkOut);
                refresh();
              } }),
            field({ label: 'Nights', name: 'wNights', type: 'number', min: 1, value: nightsBetween(model.checkIn, model.checkOut),
              onChange: e => {
                model.checkOut = addDays(model.checkIn, Math.max(1, Number(e.target.value) || 1));
                const el = qs('[name="wCheckOut"]', root); if (el) el.value = model.checkOut;
                refresh();
              } }),
            field({ label: 'Booking source', name: 'wSource', type: 'select', value: model.source,
              options: BOOKING_SOURCES.map(s => ({ value: s.id, label: s.label })),
              onChange: e => { model.source = e.target.value; } })
          ]),

          h('div.field', [h('div.field__label', { text: `${word} — vacant only` }), unitBox]),
          warnBox,

          h('div.form-grid.form-grid--4', [
            field({ label: 'Adults', name: 'wAdults', type: 'number', min: 1, value: model.adults,
              onChange: e => { model.adults = Number(e.target.value) || 1; refresh(); } }),
            field({ label: 'Children', name: 'wChildren', type: 'number', min: 0, value: model.children,
              onChange: e => { model.children = Number(e.target.value) || 0; refresh(); } }),
            field({ label: 'Extra beds', name: 'wBeds', type: 'number', min: 0, value: model.extraBeds,
              onChange: e => { model.extraBeds = Number(e.target.value) || 0; renderBill(); } }),
            field({ label: 'Rate per night', name: 'wRate', type: 'number', min: 0, value: model.rate,
              hint: 'blank = unit rate', onInput: e => { model.rate = e.target.value; renderBill(); } })
          ]),

          h('div.form-grid.form-grid--4', [
            field({ label: 'Discount', name: 'wDiscount', type: 'number', min: 0, value: model.discount,
              onInput: e => { model.discount = e.target.value; renderBill(); } }),
            field({ label: 'Advance received', name: 'wAdvance', type: 'number', min: 0, value: model.advance,
              onInput: e => { model.advance = e.target.value; renderBill(); } })
          ]),

          h('div.field', [h('div.field__label', { text: 'Payment method' }), methodBox])
        ])),

        card({ title: 'C · Register details' }, h('div.stack', [
          h('div.form-grid.form-grid--4', [
            field({ label: 'Coming from', name: 'wFrom', placeholder: 'Islamabad', onInput: e => { model.comingFrom = e.target.value; } }),
            field({ label: 'Going to', name: 'wTo', placeholder: 'Kalam', onInput: e => { model.goingTo = e.target.value; } }),
            field({ label: 'Vehicle number', name: 'wVehicle', mono: true, placeholder: 'LEB-1234', onInput: e => { model.vehicleNo = e.target.value; } }),
            field({ label: 'Purpose', name: 'wPurpose', type: 'select', value: model.purpose,
              options: ['Tourism', 'Business', 'Family', 'Medical', 'Other'], onChange: e => { model.purpose = e.target.value; } })
          ]),
          field({ label: 'Remarks', name: 'wNotes', type: 'textarea', rows: 2,
            placeholder: 'Heater needed, arriving late', onInput: e => { model.notes = e.target.value; } })
        ])),

        card({ title: 'D · Accompanying persons' }, companionBox)
      ]),

      h('aside.rail', card({ title: 'Bill summary' }, h('div.stack', [
        billBox,
        h('div.stack.stack--sm', { style: { marginTop: '6px' } }, [
          h('button.btn.btn--primary.btn--block.btn--lg', { type: 'button', text: 'Check in guest',
            onclick: e => save(false, e.currentTarget) }),
          h('button.btn.btn--block', { type: 'button', text: 'Check in and print slip',
            onclick: e => save(true, e.currentTarget) })
        ]),
        h('p.text-xs.text-muted', { style: { marginTop: '4px', lineHeight: '1.5' },
          text: `On save: the guest is recorded, a booking number and register serial are issued, the ${word.toLowerCase()} is marked occupied, and any advance is receipted.` })
      ])))
    ])
  ]);

  renderGuest();
  renderMethods();
  renderCompanions();
  refresh();

  return root;
}

/* ------------------------------------------------- checking in a booking */

/** Check-in for an existing booking — requirement 14's screen. */
export function checkInDialog(ctx, reservation) {
  const { store, app } = ctx;
  const currency = store.currency();
  const word = store.unitWord();
  const guest = store.db.get('guests', reservation.guestId);
  const bill = folioApi.billFor(store, reservation, { live: true });

  const model = {
    unitId: reservation.unitId,
    adults: reservation.adults,
    children: reservation.children,
    advance: '',
    paymentMethod: 'cash',
    notes: reservation.notes || '',
    companions: (reservation.companions || []).slice()
  };

  const unitBox = h('div');
  const methodBox = h('div');
  const companionBox = h('div');

  function renderUnits() {
    const options = reservationsApi.availableUnits(store, reservation.checkIn, reservation.checkOut, { excludeId: reservation.id });
    const current = store.db.get('units', reservation.unitId);
    const list = current && !options.some(u => u.id === current.id) ? [current].concat(options) : options;
    mount(unitBox, h('div.chips', list.map(u => h('button.chip', {
      type: 'button', class: u.id === model.unitId ? 'is-on' : null,
      onclick: () => { model.unitId = u.id; renderUnits(); }
    }, [h('span.mono.strong', { text: u.code })]))));
  }

  function renderMethods() {
    mount(methodBox, chipGroup({
      options: PAYMENT_METHODS.map(m => ({ value: m.id, label: m.label })),
      value: model.paymentMethod, onChange: v => { model.paymentMethod = v; renderMethods(); }
    }));
  }

  function renderCompanions() {
    mount(companionBox, h('div.stack.stack--sm', [
      model.companions.length
        ? h('div.stack.stack--sm', model.companions.map((c, i) => h('div.row.row--tight', [
            h('input.input', { placeholder: 'Name', value: c.name || '', style: { flex: '2' },
              oninput: e => { model.companions[i].name = e.target.value; } }),
            h('input.input', { placeholder: 'Relation', value: c.relation || '', style: { flex: '1' },
              oninput: e => { model.companions[i].relation = e.target.value; } }),
            h('input.input', { placeholder: 'Age', value: c.age || '', style: { width: '70px' },
              oninput: e => { model.companions[i].age = e.target.value; } }),
            h('button.btn.btn--sm.btn--ghost', { type: 'button', text: '×',
              onclick: () => { model.companions.splice(i, 1); renderCompanions(); } })
          ])))
        : h('div.text-sm.text-muted', { text: 'None recorded.' }),
      h('button.btn.btn--sm', { type: 'button', text: '+ Add person',
        onclick: () => { model.companions.push({ name: '', relation: '', age: '', cnic: '' }); renderCompanions(); } })
    ]));
  }

  const dialog = modal({
    title: `Check in · ${reservation.code}`,
    subtitle: guest ? guest.fullName : '',
    size: 'wide',
    body: h('div.stack', [
      reservation.checkIn < today()
        ? alert('warn', 'Late arrival', `This booking was due to arrive on ${formatDate(reservation.checkIn)}.`) : null,

      h('div.form-grid.form-grid--3', [
        field({ label: 'Guest', value: guest ? guest.fullName : '—', readOnly: true }),
        field({ label: 'Phone', value: guest ? guest.phone : '—', readOnly: true, mono: true }),
        field({ label: 'CNIC', value: guest ? (store.session.can('guest.viewCnic') ? guest.cnic : '•••••••') : '—', readOnly: true, mono: true }),
        field({ label: 'Check-in', value: formatDate(reservation.checkIn), readOnly: true }),
        field({ label: 'Expected check-out', value: `${formatDate(reservation.checkOut)}  ${store.property.checkOutTime || ''}`, readOnly: true }),
        field({ label: 'Nights', value: String(reservation.nights), readOnly: true })
      ]),

      h('div.field', [
        h('div.field__label', { text: `${word} — change if needed` }),
        unitBox
      ]),

      h('div.form-grid.form-grid--3', [
        field({ label: 'Adults', name: 'adults', type: 'number', min: 1, value: model.adults,
          onChange: e => { model.adults = Number(e.target.value) || 1; } }),
        field({ label: 'Children', name: 'children', type: 'number', min: 0, value: model.children,
          onChange: e => { model.children = Number(e.target.value) || 0; } }),
        field({ label: 'Advance now', name: 'advance', type: 'number', min: 0, value: model.advance,
          hint: `Balance is ${formatMoney(bill.balance, currency)}`,
          onInput: e => { model.advance = e.target.value; } })
      ]),

      h('div.field', [h('div.field__label', { text: 'Payment method' }), methodBox]),

      h('div.field', [h('div.field__label', { text: 'Accompanying persons' }), companionBox]),

      field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2, value: model.notes,
        onInput: e => { model.notes = e.target.value; } }),

      card({ title: 'Bill' }, totalsRail([
        { label: 'Total', value: bill.total },
        { label: 'Already paid', value: bill.paid },
        { label: 'Balance', value: bill.balance, rule: true, kind: bill.balance > 0 ? 'balance' : 'settled' }
      ], currency))
    ]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Check in',
        onclick: e => busy(e.currentTarget, async () => {
          try {
            const saved = await staysApi.checkIn(store, reservation.id, {
              unitId: model.unitId, adults: model.adults, children: model.children,
              advance: model.advance, paymentMethod: model.paymentMethod,
              notes: model.notes, companions: model.companions.filter(c => c.name)
            });
            toastOk('Guest checked in.', `${guest ? guest.fullName : ''} · ${unitsApi.unitLabel(store, saved.unitId)}`);
            dialog.close();
            printCheckInSlip(store, saved);
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ]
  });

  renderUnits();
  renderMethods();
  renderCompanions();
  return dialog;
}
