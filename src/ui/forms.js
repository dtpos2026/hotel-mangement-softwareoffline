/**
 * The shared modal editors.
 *
 * These live here rather than inside a screen because the same editor is
 * reached from several places — a guest is created from the guest list, from
 * check-in and from a walk-in, and all three must behave identically.
 */

import { h, formValues, applyErrors, busy, qs, qsa, mount, readImage } from './dom.js';
import { modal, toast, ok as toastOk, fail, confirm, promptText } from './feedback.js';
import { field, checkbox, chipGroup, dataTable, alert, conflictList, moneyText, badge } from './components.js';
import { formatCnic, formatPhone } from '../core/validate.js';
import { formatMoney, toMoney } from '../core/money.js';
import { today, addDays, formatDate, nightsBetween } from '../core/dates.js';
import { PAYMENT_METHODS, BOOKING_SOURCES, GUEST_TYPES, CHARGE_CATEGORIES, EXPENSE_CATEGORIES, UNIT_STATUS } from '../core/schema.js';
import * as guestsApi from '../domain/guests.js';
import * as unitsApi from '../domain/units.js';
import * as reservationsApi from '../domain/reservations.js';
import * as paymentsApi from '../domain/payments.js';
import * as folioApi from '../domain/folio.js';
import * as expensesApi from '../domain/expenses.js';
import { quote } from '../domain/pricing.js';

const opt = (list) => list.map(x => ({ value: x.id, label: x.label }));

/* ------------------------------------------------------------------ guest */

export function guestForm(store, opts) {
  const o = opts || {};
  const existing = o.guest || null;
  const form = h('div.form-grid.form-grid--3');

  const body = h('div.stack', [
    form,
    h('div', { id: 'dupWarn' })
  ]);

  const build = () => mount(form, [
    field({ label: 'Full name', name: 'fullName', required: true, value: existing ? existing.fullName : (o.prefillName || ''), placeholder: 'Muhammad Bilal', span: 2, autofocus: true }),
    field({ label: 'Name in Urdu', name: 'fullNameUr', value: existing ? existing.fullNameUr : '', placeholder: 'محمد بلال', urdu: true }),
    field({ label: 'Father / husband name', name: 'fatherName', value: existing ? existing.fatherName : '', placeholder: 'Abdul Rahman' }),
    field({ label: 'CNIC', name: 'cnic', mono: true, value: existing ? existing.cnic : '', placeholder: '15302-1234567-1',
            onInput: e => { e.target.value = formatCnic(e.target.value); } }),
    field({ label: 'Passport', name: 'passport', mono: true, value: existing ? existing.passport : '', placeholder: 'AB1234567' }),
    field({ label: 'Phone', name: 'phone', mono: true, value: existing ? existing.phone : '', placeholder: '0300-1234567',
            onInput: e => { e.target.value = formatPhone(e.target.value); } }),
    field({ label: 'WhatsApp', name: 'whatsapp', mono: true, value: existing ? existing.whatsapp : '', placeholder: '0300-1234567',
            onInput: e => { e.target.value = formatPhone(e.target.value); } }),
    field({ label: 'Email', name: 'email', type: 'email', value: existing ? existing.email : '', placeholder: 'guest@example.com' }),
    field({ label: 'Address', name: 'address', value: existing ? existing.address : '', placeholder: 'House 4, Street 11, Gulberg', span: 2 }),
    field({ label: 'City', name: 'city', value: existing ? existing.city : '', placeholder: 'Lahore' }),
    field({ label: 'Country', name: 'country', value: existing ? existing.country : 'Pakistan' }),
    field({ label: 'Guest type', name: 'guestType', type: 'select', value: existing ? existing.guestType : 'individual', options: opt(GUEST_TYPES) }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', value: existing ? existing.notes : '', placeholder: 'Repeat guest, prefers upper floor', span: 'full' })
  ]);
  build();

  // Warn about an existing profile before a duplicate is created.
  const checkDuplicate = () => {
    if (existing) return;
    const values = formValues(form);
    const match = guestsApi.findMatch(store, values);
    mount(qs('#dupWarn', body), match ? alert('info', 'This guest already exists',
      `${match.guest.fullName} is already on file (matched on ${match.matchedOn}). Saving will update that profile instead of creating a second one.`) : null);
  };

  const dialog = modal({
    title: existing ? 'Edit guest' : 'New guest',
    subtitle: existing ? existing.code : 'Reception keeps one profile per person.',
    size: 'wide',
    body,
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: existing ? 'Save changes' : 'Save guest',
        onclick: e => busy(e.currentTarget, async () => {
          const values = formValues(form);
          try {
            const saved = await guestsApi.saveGuest(store, Object.assign({ id: existing ? existing.id : '' }, values));
            toastOk(existing ? 'Guest updated' : 'Guest saved', saved.fullName);
            dialog.close();
            if (o.onSaved) o.onSaved(saved);
          } catch (err) {
            applyErrors(form, err.fields);
            fail(err, err.fields ? 'Please correct the highlighted fields' : null);
          }
        }) })
    ]
  });

  ['cnic', 'phone', 'passport'].forEach(name => {
    const el = qs(`[name="${name}"]`, form);
    if (el) el.addEventListener('blur', checkDuplicate);
  });

  return dialog;
}

/* -------------------------------------------------------------- unit type */

export function unitTypeForm(store, opts) {
  const o = opts || {};
  const existing = o.unitType || null;
  const form = h('div.form-grid.form-grid--3', [
    field({ label: 'Type name', name: 'name', required: true, value: existing ? existing.name : '', placeholder: 'Deluxe Double', span: 2, autofocus: true }),
    field({ label: 'Name in Urdu', name: 'nameUr', value: existing ? existing.nameUr : '', urdu: true }),
    field({ label: 'Adults capacity', name: 'capacityAdults', type: 'number', min: 0, value: existing ? existing.capacityAdults : 2 }),
    field({ label: 'Children capacity', name: 'capacityChildren', type: 'number', min: 0, value: existing ? existing.capacityChildren : 1 }),
    field({ label: 'Default rate', name: 'defaultRate', type: 'number', min: 0, value: existing ? existing.defaultRate : 0, hint: 'per night' }),
    field({ label: 'Weekend rate', name: 'weekendRate', type: 'number', min: 0, value: existing ? existing.weekendRate : 0, hint: 'leave 0 to use the default' }),
    field({ label: 'Extra person charge', name: 'extraPersonCharge', type: 'number', min: 0, value: existing ? existing.extraPersonCharge : 0 }),
    field({ label: 'Extra bed charge', name: 'extraBedCharge', type: 'number', min: 0, value: existing ? existing.extraBedCharge : 0 }),
    field({ label: 'Amenities', name: 'amenitiesText', value: existing ? (existing.amenities || []).join(', ') : '',
            placeholder: 'AC, Geyser, TV, Wi-Fi', span: 'full', hint: 'Separate with commas' }),
    field({ label: 'Description', name: 'description', type: 'textarea', value: existing ? existing.description : '', span: 'full' })
  ]);

  const dialog = modal({
    title: existing ? 'Edit unit type' : 'New unit type',
    subtitle: 'A reusable template: room, cottage, apartment, villa or shared bed.',
    size: 'wide',
    body: form,
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Save type',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          v.amenities = String(v.amenitiesText || '').split(',').map(s => s.trim()).filter(Boolean);
          delete v.amenitiesText;
          try {
            const saved = await unitsApi.saveUnitType(store, Object.assign({ id: existing ? existing.id : '' }, v));
            toastOk('Unit type saved', saved.name);
            dialog.close();
            if (o.onSaved) o.onSaved(saved);
          } catch (err) { applyErrors(form, err.fields); fail(err); }
        }) })
    ]
  });
  return dialog;
}

/* ------------------------------------------------------------------- unit */

export function unitForm(store, opts) {
  const o = opts || {};
  const existing = o.unit || null;
  const types = unitsApi.listUnitTypes(store);
  const word = store.unitWord();

  if (!types.length) {
    toast('warn', 'Add a unit type first', 'Every unit belongs to a type such as Deluxe Double or Cottage.');
    return unitTypeForm(store, { onSaved: () => unitForm(store, o) });
  }

  const form = h('div.form-grid.form-grid--3', [
    field({ label: word + ' number / name', name: 'code', required: true, mono: true,
            value: existing ? existing.code : '', placeholder: '204', autofocus: true }),
    field({ label: 'Unit type', name: 'unitTypeId', type: 'select', required: true,
            value: existing ? existing.unitTypeId : types[0].id,
            options: types.map(t => ({ value: t.id, label: t.name })),
            onChange: e => applyTypeDefaults(e.target.value) }),
    field({ label: 'Floor / block', name: 'floor', value: existing ? existing.floor : '', placeholder: 'Ground' }),
    field({ label: 'Adults capacity', name: 'capacityAdults', type: 'number', min: 0, value: existing ? existing.capacityAdults : 2 }),
    field({ label: 'Children capacity', name: 'capacityChildren', type: 'number', min: 0, value: existing ? existing.capacityChildren : 1 }),
    field({ label: 'Bed configuration', name: 'bedConfig', value: existing ? existing.bedConfig : '', placeholder: '1 double + 1 single' }),
    field({ label: 'Base nightly rate', name: 'baseRate', type: 'number', min: 0, value: existing ? existing.baseRate : 0, required: true }),
    field({ label: 'Weekend rate', name: 'weekendRate', type: 'number', min: 0, value: existing ? existing.weekendRate : 0, hint: '0 = same as base' }),
    field({ label: 'Status', name: 'status', type: 'select', value: existing ? existing.status : 'available',
            options: UNIT_STATUS.filter(s => s.id !== 'occupied').map(s => ({ value: s.id, label: s.label })),
            hint: existing && existing.status === 'occupied' ? 'A guest is in this unit; status is locked' : null }),
    field({ label: 'Extra person charge', name: 'extraPersonCharge', type: 'number', min: 0, value: existing ? existing.extraPersonCharge : 0 }),
    field({ label: 'Extra bed charge', name: 'extraBedCharge', type: 'number', min: 0, value: existing ? existing.extraBedCharge : 0 }),
    field({ label: 'Amenities', name: 'amenitiesText', value: existing ? (existing.amenities || []).join(', ') : '', placeholder: 'AC, Geyser, TV' }),
    field({ label: 'Description', name: 'description', type: 'textarea', value: existing ? existing.description : '', span: 2 }),
    field({ label: 'Internal notes', name: 'notes', type: 'textarea', value: existing ? existing.notes : '', placeholder: 'Not visible to guests' })
  ]);

  /** Choosing a type pre-fills its rates, but never overwrites a typed value. */
  function applyTypeDefaults(typeId) {
    const type = store.db.get('unitTypes', typeId);
    if (!type) return;
    const pairs = [['capacityAdults', 'capacityAdults'], ['capacityChildren', 'capacityChildren'],
                   ['baseRate', 'defaultRate'], ['weekendRate', 'weekendRate'],
                   ['extraPersonCharge', 'extraPersonCharge'], ['extraBedCharge', 'extraBedCharge']];
    pairs.forEach(([fieldName, typeKey]) => {
      const el = qs(`[name="${fieldName}"]`, form);
      if (el && (el.value === '' || Number(el.value) === 0)) el.value = String(type[typeKey] || 0);
    });
  }
  if (!existing) applyTypeDefaults(types[0].id);

  const dialog = modal({
    title: existing ? `Edit ${word.toLowerCase()} ${existing.code}` : `New ${word.toLowerCase()}`,
    size: 'wide',
    body: form,
    footer: [
      existing && store.session.can('unit.archive')
        ? h('button.btn.btn--danger', { type: 'button', text: 'Archive', style: { marginInlineEnd: 'auto' },
            onclick: async () => {
              const usage = unitsApi.unitUsage(store, existing.id);
              const goAhead = await confirm({
                title: `Archive ${existing.code}?`,
                message: usage.reservations
                  ? `This unit has ${usage.reservations} booking(s) in its history, so it cannot be deleted. Archiving removes it from the board while keeping every old record intact.`
                  : 'This unit has never been sold. Archiving removes it from the board; you can restore it later.',
                confirmLabel: 'Archive', danger: true
              });
              if (!goAhead) return;
              try { await unitsApi.archiveUnit(store, existing.id); toastOk('Unit archived', existing.code); dialog.close(); if (o.onSaved) o.onSaved(null); }
              catch (err) { fail(err); }
            } })
        : null,
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Save',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          v.amenities = String(v.amenitiesText || '').split(',').map(s => s.trim()).filter(Boolean);
          delete v.amenitiesText;
          try {
            const saved = await unitsApi.saveUnit(store, Object.assign({ id: existing ? existing.id : '' }, v));
            toastOk('Saved', `${word} ${saved.code}`);
            dialog.close();
            if (o.onSaved) o.onSaved(saved);
          } catch (err) { applyErrors(form, err.fields); fail(err); }
        }) })
    ]
  });
  return dialog;
}

/* ---------------------------------------------------------------- payment */

export function paymentForm(store, opts) {
  const o = opts || {};
  const reservation = o.reservation || null;
  const bill = reservation ? folioApi.billFor(store, reservation, { live: !reservation.invoiceNo }) : null;
  const currency = store.currency();
  let method = o.method || 'cash';

  const methodRow = h('div');
  const renderMethods = () => mount(methodRow, chipGroup({
    options: PAYMENT_METHODS.map(m => ({ value: m.id, label: m.label })),
    value: method,
    onChange: v => { method = v; renderMethods(); }
  }));
  renderMethods();

  const guestOptions = reservation ? null : guestsApi.listGuests(store).slice(0, 400);

  const form = h('div.stack', [
    reservation && bill ? alert(bill.balance > 0 ? 'warn' : 'ok',
      `${reservation.code} · balance ${formatMoney(bill.balance, currency)}`,
      `Total ${formatMoney(bill.total, currency)} · already paid ${formatMoney(bill.paid, currency)}`) : null,

    h('div.form-grid.form-grid--2', [
      !reservation ? field({ label: 'Guest', name: 'guestId', type: 'select',
        options: [{ value: '', label: '— No guest —' }].concat((guestOptions || []).map(g => ({ value: g.id, label: `${g.fullName}${g.phone ? ' · ' + g.phone : ''}` }))) }) : null,
      field({ label: 'Amount', name: 'amount', type: 'number', min: 0, required: true, autofocus: true,
              value: o.amount !== undefined ? o.amount : (bill && bill.balance > 0 ? bill.balance : ''),
              hint: bill && bill.balance > 0 ? `Balance is ${formatMoney(bill.balance, currency)}` : null }),
      field({ label: 'Reference', name: 'reference', value: '', placeholder: 'Transaction / slip number' })
    ]),

    h('div.field', [h('div.field__label', { text: 'Payment method' }), methodRow]),

    field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2, value: o.notes || '' })
  ]);

  const dialog = modal({
    title: o.kind === 'refund' ? 'Record refund' : o.kind === 'advance' ? 'Record advance' : 'Record payment',
    subtitle: reservation ? `Booking ${reservation.code}` : 'Standalone payment at reception',
    body: form,
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: o.kind === 'refund' ? 'Record refund' : 'Record payment',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            const saved = await paymentsApi.recordPayment(store, {
              reservationId: reservation ? reservation.id : '',
              guestId: reservation ? reservation.guestId : v.guestId,
              amount: v.amount, method, reference: v.reference, notes: v.notes,
              kind: o.kind || 'payment'
            });
            toastOk('Payment recorded successfully.', `${saved.code} · ${formatMoney(saved.amount, currency)}`);
            dialog.close();
            if (o.onSaved) o.onSaved(saved);
          } catch (err) { applyErrors(form, err.fields); fail(err); }
        }) })
    ]
  });
  return dialog;
}

/* ----------------------------------------------------------- folio charge */

export function chargeForm(store, opts) {
  const o = opts || {};
  const reservation = o.reservation;
  const currency = store.currency();
  const total = h('div.strong', { text: formatMoney(0, currency) });

  const recalc = () => {
    const v = formValues(form);
    total.textContent = formatMoney(toMoney(v.rate) * (Number(v.qty) || 0), currency);
  };

  const form = h('div.form-grid.form-grid--2', [
    field({ label: 'Category', name: 'category', type: 'select', value: 'food', options: opt(CHARGE_CATEGORIES) }),
    field({ label: 'Date', name: 'date', type: 'date', value: today() }),
    field({ label: 'Description', name: 'description', required: true, autofocus: true,
            placeholder: 'Trout fish, Chapli Kabab, Roti', span: 'full' }),
    field({ label: 'Quantity', name: 'qty', type: 'number', min: 1, step: '1', value: 1, onInput: recalc }),
    field({ label: 'Rate', name: 'rate', type: 'number', min: 0, value: '', onInput: recalc })
  ]);

  const dialog = modal({
    title: 'Add charge to folio',
    subtitle: `${reservation.code} · ${formatDate(reservation.checkIn)} → ${formatDate(reservation.checkOut)}`,
    body: h('div.stack', [form, h('div.row', { style: { justifyContent: 'flex-end', gap: '10px' } },
      [h('span.text-muted', { text: 'Amount' }), total])]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Add charge',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            const saved = await folioApi.addCharge(store, reservation.id, v);
            toastOk('Charge added', `${saved.description} · ${formatMoney(saved.amount, currency)}`);
            dialog.close();
            if (o.onSaved) o.onSaved(saved);
          } catch (err) { applyErrors(form, err.fields); fail(err); }
        }) })
    ]
  });
  return dialog;
}

/* ---------------------------------------------------------------- expense */

export function expenseForm(store, opts) {
  const o = opts || {};
  let method = 'cash';
  const methodRow = h('div');
  const renderMethods = () => mount(methodRow, chipGroup({
    options: PAYMENT_METHODS.map(m => ({ value: m.id, label: m.label })),
    value: method, onChange: v => { method = v; renderMethods(); }
  }));
  renderMethods();

  const form = h('div.stack', [
    h('div.form-grid.form-grid--2', [
      field({ label: 'Date', name: 'date', type: 'date', required: true, value: today() }),
      field({ label: 'Category', name: 'category', type: 'select', value: 'Electricity', options: EXPENSE_CATEGORIES }),
      field({ label: 'Description', name: 'description', required: true, autofocus: true, placeholder: 'WAPDA bill for July', span: 'full' }),
      field({ label: 'Amount', name: 'amount', type: 'number', min: 0, required: true }),
      field({ label: 'Paid to', name: 'paidTo', placeholder: 'Supplier or person' })
    ]),
    h('div.field', [h('div.field__label', { text: 'Paid by' }), methodRow]),
    field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2 })
  ]);

  const dialog = modal({
    title: 'Record expense',
    body: form,
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Save expense',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            const saved = await expensesApi.recordExpense(store, Object.assign({}, v, { method }));
            toastOk('Expense recorded', `${saved.code} · ${formatMoney(saved.amount, store.currency())}`);
            dialog.close();
            if (o.onSaved) o.onSaved(saved);
          } catch (err) { applyErrors(form, err.fields); fail(err); }
        }) })
    ]
  });
  return dialog;
}

/* ------------------------------------------------------------ maintenance */

export function maintenanceForm(store, opts) {
  const o = opts || {};
  const units = unitsApi.listUnits(store);
  const form = h('div.form-grid.form-grid--2', [
    field({ label: 'Unit', name: 'unitId', type: 'select', required: true,
            value: o.unitId || (units[0] && units[0].id),
            options: units.map(u => ({ value: u.id, label: u.code })) }),
    field({ label: 'Reason', name: 'reason', required: true, autofocus: true, placeholder: 'Geyser replacement' }),
    field({ label: 'Start date', name: 'startDate', type: 'date', required: true, value: today() }),
    field({ label: 'Expected completion', name: 'expectedEnd', type: 'date', value: addDays(today(), 1) }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2, span: 'full' })
  ]);

  const dialog = modal({
    title: 'Put a unit under maintenance',
    subtitle: 'A unit under maintenance cannot be booked.',
    body: form,
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Start maintenance',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            const { openMaintenance } = await import('../domain/housekeeping.js');
            const saved = await openMaintenance(store, v);
            toastOk('Maintenance started', v.reason);
            dialog.close();
            if (o.onSaved) o.onSaved(saved);
          } catch (err) {
            applyErrors(form, err.fields);
            if (err.conflicts) {
              mount(qs('.modal__body', dialog.el).lastChild || form, form);
              fail(err);
            } else fail(err);
          }
        }) })
    ]
  });
  return dialog;
}

/* --------------------------------------------------------- guest picker */

/** Search-and-pick, with "create new" built in. Used by booking and walk-in. */
export function guestPicker(store, onPick) {
  const results = h('div');
  const input = h('input.input', {
    placeholder: 'Search by name, CNIC or phone…', autofocus: true,
    oninput: e => render(e.target.value)
  });

  const render = (term) => {
    const list = guestsApi.searchGuests(store, term, 30);
    mount(results, list.length
      ? h('div.stack.stack--sm', list.map(g => h('button.btn.btn--block', {
          type: 'button', style: { justifyContent: 'flex-start', textAlign: 'start' },
          onclick: () => { dialog.close(); onPick(g); }
        }, [
          h('div', { style: { minWidth: 0 } }, [
            h('div.strong', { text: g.fullName }),
            h('div.mono.text-xs.text-muted', { text: [g.cnic, g.phone, g.city].filter(Boolean).join(' · ') || g.code })
          ])
        ])))
      : h('div.empty', [
          h('div.empty__title', { text: term ? 'No guest matches' : 'No guests yet' }),
          h('div.empty__body', { text: 'Create a new profile instead.' })
        ]));
  };
  render('');

  const dialog = modal({
    title: 'Choose guest',
    body: h('div.stack', [input, results]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'New guest',
        onclick: () => { dialog.close(); guestForm(store, { prefillName: input.value, onSaved: onPick }); } })
    ]
  });
  return dialog;
}
