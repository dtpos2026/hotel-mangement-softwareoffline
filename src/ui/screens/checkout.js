/**
 * Check-out and final settlement (requirement 15).
 *
 * The settlement panel shows exactly what is owed and why before anything is
 * committed. A pending balance is a hard stop that must be explicitly accepted,
 * and only a role holding stay.checkoutWithBalance can accept it.
 */

import { h, mount, qs, busy } from '../dom.js';
import { card, dataTable, emptyState, pageHead, field, chipGroup, alert, totalsRail, moneyText, badge, railRows } from '../components.js';
import { toast, ok as toastOk, fail, confirm, promptText, modal } from '../feedback.js';
import { chargeForm, paymentForm } from '../forms.js';
import * as reservationsApi from '../../domain/reservations.js';
import * as staysApi from '../../domain/stays.js';
import * as unitsApi from '../../domain/units.js';
import * as folioApi from '../../domain/folio.js';
import { formatMoney, toMoney } from '../../core/money.js';
import { today, formatDate, nightsBetween } from '../../core/dates.js';
import { PAYMENT_METHODS } from '../../core/schema.js';
import { printBill, printInvoice, printPaymentReceipt } from '../print-actions.js';

const state = { selectedId: '' };

export function render(ctx) {
  const { store, app, params } = ctx;
  const word = store.unitWord();
  const currency = store.currency();

  if (params.reservationId) { state.selectedId = params.reservationId; params.reservationId = null; }

  const dueToday = reservationsApi.departuresOn(store, today()).filter(r => r.status === 'checked_in');
  const overdue = reservationsApi.overdue(store, today());
  const all = reservationsApi.inHouse(store);

  const candidates = overdue.concat(dueToday.filter(r => !overdue.some(o => o.id === r.id)))
    .concat(all.filter(r => !overdue.some(o => o.id === r.id) && !dueToday.some(d => d.id === r.id)));

  if (!state.selectedId || !candidates.some(r => r.id === state.selectedId)) {
    state.selectedId = candidates.length ? candidates[0].id : '';
  }
  const selected = state.selectedId ? store.db.get('reservations', state.selectedId) : null;

  const head = pageHead('Check out and clearance', 'روانگی اور کلیئرنس', []);

  if (!candidates.length) {
    return [head, card({}, emptyState({
      title: 'Nobody is checked in',
      body: 'Check a guest in first; they will appear here when it is time to leave.',
      action: h('button.btn.btn--primary', { type: 'button', text: 'Go to check-in', onclick: () => app.go('checkin') })
    }))];
  }

  return [
    head,
    h('div.split.split--rail', [
      h('div.stack', [
        overdue.length ? alert('due', `${overdue.length} stay(s) are past their check-out date`,
          'Settle and close them, or extend the stay from the booking screen.') : null,

        card({ title: 'In house', note: `${all.length} stay(s) · ${dueToday.length} due out today`, flush: true },
          dataTable({
            currency, compact: true, selectedId: state.selectedId,
            columns: [
              { key: 'unit', label: word, render: r => h('span.mono.strong', { text: unitsApi.unitLabel(store, r.unitId) }) },
              { key: 'guest', label: 'Guest', render: r => (store.db.get('guests', r.guestId) || {}).fullName || '—' },
              { key: 'checkIn', label: 'In', format: 'date' },
              { key: 'checkOut', label: 'Due out', render: r => h('span', {
                  class: r.checkOut < today() ? 'money-due' : (r.checkOut === today() ? 'strong' : null),
                  text: formatDate(r.checkOut) }) },
              { key: 'nights', label: 'Nt', align: 'end' },
              { key: 'total', label: 'Charges', align: 'end', render: r => formatMoney(folioApi.billFor(store, r).total, currency) },
              { key: 'paid', label: 'Paid', align: 'end', render: r => formatMoney(folioApi.billFor(store, r).paid, currency) },
              { key: 'balance', label: 'Balance', align: 'end', render: r => {
                  const b = folioApi.billFor(store, r).balance;
                  return moneyText(b, currency, b > 0 ? 'due' : 'ok');
                } },
              { key: 'flag', label: '', render: r => r.checkOut < today() ? badge('Overdue', 'due')
                  : r.checkOut === today() ? badge('Due out', 'warn') : null }
            ],
            rows: candidates,
            onRowClick: r => { state.selectedId = r.id; app.refresh(); }
          })),

        selected ? folioPanel(ctx, selected) : null
      ]),

      selected ? settlementRail(ctx, selected) : null
    ])
  ];
}

function folioPanel(ctx, reservation) {
  const { store, app } = ctx;
  const currency = store.currency();
  const bill = folioApi.billFor(store, reservation, { live: true });

  return h('div.stack', [
    card({
      title: 'Folio',
      note: `${reservation.code} · ${bill.lines.length} line(s)`,
      flush: true,
      tools: store.session.can('folio.add')
        ? [h('button.btn.btn--sm', { type: 'button', text: '+ Add charge',
            onclick: () => chargeForm(store, { reservation, onSaved: () => app.refresh() }) })] : []
    }, dataTable({
      currency, compact: true,
      columns: [
        { key: 'date', label: 'Date', format: 'date' },
        { key: 'description', label: 'Description' },
        { key: 'category', label: 'Group', render: l => folioApi.chargeCategoryLabel(l.category) },
        { key: 'qty', label: 'Qty', align: 'end' },
        { key: 'rate', label: 'Rate', align: 'end', format: 'money' },
        { key: 'amount', label: 'Amount', align: 'end', format: 'money' },
        { key: 'act', label: '', render: l => (!l.system && store.session.can('folio.void'))
            ? h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Void',
                onclick: async () => {
                  const reason = await promptText({ title: 'Void this charge?', label: 'Reason',
                    placeholder: 'Added to the wrong folio', danger: true, confirmLabel: 'Void charge' });
                  if (reason === null) return;
                  try { await folioApi.voidCharge(store, l.id, reason); toastOk('Charge voided'); }
                  catch (err) { fail(err); }
                } })
            : null }
      ],
      rows: bill.lines
    })),

    card({
      title: 'Payments',
      note: formatMoney(bill.paid, currency),
      flush: true,
      tools: store.session.can('payment.create')
        ? [h('button.btn.btn--sm', { type: 'button', text: '+ Payment',
            onclick: () => paymentForm(store, { reservation, onSaved: p => { printPaymentReceipt(store, p); app.refresh(); } }) })] : []
    }, dataTable({
      currency, compact: true,
      columns: [
        { key: 'code', label: 'Receipt' },
        { key: 'at', label: 'Date', format: 'datetime' },
        { key: 'method', label: 'Method', render: p => (PAYMENT_METHODS.find(m => m.id === p.method) || {}).label || p.method },
        { key: 'kind', label: 'Type' },
        { key: 'reference', label: 'Reference' },
        { key: 'amount', label: 'Amount', align: 'end', format: 'money' },
        { key: 'act', label: '', render: p => h('button.btn.btn--sm.btn--ghost', {
            type: 'button', text: 'Receipt', onclick: () => printPaymentReceipt(store, p) }) }
      ],
      rows: bill.payments,
      empty: emptyState({ title: 'No payments recorded', body: 'Record the advance or the settlement here.' })
    }))
  ]);
}

function settlementRail(ctx, reservation) {
  const { store, app } = ctx;
  const currency = store.currency();
  const word = store.unitWord();
  const guest = store.db.get('guests', reservation.guestId);
  const unit = store.db.get('units', reservation.unitId);
  const preview = staysApi.settlementPreview(store, reservation);
  const bill = preview.bill;
  const booking = store.setting('booking');

  let method = 'cash';
  let payNow = bill.balance > 0 ? bill.balance : 0;

  const methodBox = h('div');
  const summaryBox = h('div');

  const renderMethods = () => mount(methodBox, chipGroup({
    options: PAYMENT_METHODS.map(m => ({ value: m.id, label: m.label })),
    value: method, onChange: v => { method = v; renderMethods(); }
  }));

  const renderSummary = () => {
    const after = bill.balance - toMoney(payNow);
    mount(summaryBox, h('div.stack', [
      totalsRail([
        { label: 'Subtotal', value: bill.gross },
        bill.discount ? { label: bill.discountLabel, value: -bill.discount } : null,
        bill.taxAmount ? { label: `${bill.tax.name} ${bill.tax.percent}%`, value: bill.taxAmount } : null,
        { label: 'Grand total', value: bill.total, rule: true, kind: 'grand' },
        { label: 'Already paid', value: bill.paid },
        { label: 'Balance now', value: bill.balance },
        toMoney(payNow) ? { label: 'Paying at check-out', value: toMoney(payNow) } : null,
        { label: after > 0 ? 'Will remain unpaid' : 'Final balance', value: Math.max(0, after),
          rule: true, kind: after > 0 ? 'balance' : 'settled' }
      ], currency),
      after > 0
        ? alert('due', 'Checkout balance pending',
            `${formatMoney(after, currency)} will stay outstanding after this check-out.` +
            (booking.allowCheckoutWithBalance
              ? ' You will be asked to confirm.'
              : ' Settings do not allow closing a stay with a balance.'))
        : null
    ]));
  };

  async function doCheckout(buttonEl) {
    return busy(buttonEl, async () => {
      const amount = toMoney(payNow);
      const after = bill.balance - amount;

      if (after > 0) {
        if (!booking.allowCheckoutWithBalance) {
          toast('error', 'Checkout balance pending',
            'Settings do not allow closing a stay with an outstanding balance. Collect the balance, or change the rule in Settings.');
          return;
        }
        if (!store.session.can('stay.checkoutWithBalance')) {
          toast('error', 'Not allowed for your role',
            'Closing a stay with an outstanding balance needs a manager or admin.');
          return;
        }
        const go = await confirm({
          title: 'Close this stay with money outstanding?',
          message: `${guest ? guest.fullName : 'This guest'} will leave owing ${formatMoney(after, currency)}. The amount stays on the outstanding report.`,
          detail: `${reservation.code} · ${unit ? unit.code : ''} · ${formatDate(reservation.checkIn)} → ${formatDate(reservation.checkOut)}`,
          tone: 'due', danger: true, confirmLabel: 'Check out with balance'
        });
        if (!go) return;
      }

      try {
        const result = await staysApi.checkOut(store, reservation.id, {
          payment: amount, paymentMethod: method, acceptBalance: true
        });
        toastOk('Guest checked out.',
          `${result.invoice.no} · ${formatMoney(result.bill.total, currency)}` +
          (result.bill.balance > 0 ? ` · ${formatMoney(result.bill.balance, currency)} outstanding` : ' · settled'));
        state.selectedId = '';
        printBill(store, result.reservation);
        app.refresh();
      } catch (err) {
        fail(err);
      }
    });
  }

  renderMethods();
  renderSummary();

  return h('aside.rail', h('div.stack', [
    card({ title: 'Settlement', tools: [badge(reservation.code, 'muted')] }, h('div.stack', [
      railRows([
        { k: 'Guest', v: guest ? guest.fullName : '—' },
        guest && guest.phone ? { k: 'Phone', v: guest.phone } : null,
        { k: word, v: unit ? unit.code : '—' },
        { k: 'Check-in', v: formatDate(reservation.checkIn) },
        { k: 'Due out', v: formatDate(reservation.checkOut) },
        { k: 'Nights', v: String(reservation.nights) },
        preview.overdue ? { k: 'Overdue by', v: `${preview.extraNights} night(s)` } : null
      ]),

      preview.overdue ? alert('warn', 'Past the check-out date',
        `The stay was due to end on ${formatDate(reservation.checkOut)}. Extend the booking first if the extra nights should be charged.`) : null,

      h('div.form-grid.form-grid--2', { style: { marginTop: '10px' } }, [
        field({ label: 'Collect now', name: 'payNow', type: 'number', min: 0, value: payNow,
          onInput: e => { payNow = e.target.value; renderSummary(); } }),
        h('div.field', { style: { justifyContent: 'flex-end' } },
          h('button.btn.btn--sm', { type: 'button', text: 'Full balance',
            onclick: () => {
              payNow = Math.max(0, bill.balance);
              const el = qs('[name="payNow"]');
              if (el) el.value = payNow;
              renderSummary();
            } }))
      ]),

      h('div.field', [h('div.field__label', { text: 'Payment method' }), methodBox]),

      summaryBox,

      h('div.stack.stack--sm', { style: { marginTop: '8px' } }, [
        store.session.can('stay.checkout')
          ? h('button.btn.btn--primary.btn--block.btn--lg', { type: 'button', text: 'Complete check-out',
              onclick: e => doCheckout(e.currentTarget) }) : null,
        h('button.btn.btn--block', { type: 'button', text: 'Print bill (80mm)',
          onclick: () => printBill(store, reservation) }),
        h('button.btn.btn--block', { type: 'button', text: 'Print invoice (A4)',
          onclick: () => printInvoice(store, reservation) }),
        store.session.can('stay.changeUnit')
          ? h('button.btn.btn--block', { type: 'button', text: 'Move to another ' + word.toLowerCase(),
              onclick: () => moveUnitDialog(ctx, reservation) }) : null,
        store.session.can('reservation.edit')
          ? h('button.btn.btn--block', { type: 'button', text: 'Extend stay',
              onclick: () => extendDialog(ctx, reservation) }) : null
      ])
    ]))
  ]));
}

/* ---------------------------------------------------------- unit move */

function moveUnitDialog(ctx, reservation) {
  const { store, app } = ctx;
  const word = store.unitWord();
  const from = today() > reservation.checkIn ? today() : reservation.checkIn;
  const options = reservationsApi.availableUnits(store, from, reservation.checkOut, { excludeId: reservation.id });
  let target = '';
  const box = h('div');

  const draw = () => mount(box, options.length
    ? h('div.chips', options.map(u => h('button.chip', {
        type: 'button', class: u.id === target ? 'is-on' : null,
        onclick: () => { target = u.id; draw(); }
      }, [h('span.mono.strong', { text: u.code }),
          h('span.text-xs', { style: { opacity: 0.7, marginInlineStart: '6px' },
            text: unitsApi.unitTypeName(store, u.unitTypeId) })])))
    : alert('warn', 'Nothing else is free', `No other ${word.toLowerCase()} is available for the rest of this stay.`));
  draw();

  const dialog = modal({
    title: `Move ${store.db.get('units', reservation.unitId) ? store.db.get('units', reservation.unitId).code : ''} guest`,
    subtitle: 'The old unit goes to housekeeping; the booking keeps its rate.',
    body: h('div.stack', [
      h('div.field', [h('div.field__label', { text: `Available ${word.toLowerCase()}s` }), box]),
      field({ label: 'Reason', name: 'reason', placeholder: 'AC not working' })
    ]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Move guest',
        onclick: e => busy(e.currentTarget, async () => {
          if (!target) { toast('warn', 'Choose a unit first'); return; }
          const reason = (qs('[name="reason"]', dialog.el) || {}).value || '';
          try {
            await staysApi.changeUnit(store, reservation.id, target, reason);
            toastOk('Guest moved', unitsApi.unitLabel(store, target));
            dialog.close();
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ]
  });
  return dialog;
}

/* ------------------------------------------------------------- extend */

function extendDialog(ctx, reservation) {
  const { store, app } = ctx;
  const currency = store.currency();
  let newOut = reservation.checkOut;
  const info = h('div');

  const draw = () => {
    const nights = nightsBetween(reservation.checkIn, newOut);
    const extra = nights - reservation.nights;
    const check = extra > 0
      ? reservationsApi.checkAvailability(store, reservation.unitId, reservation.checkOut, newOut, reservation.id)
      : { available: true };
    mount(info, h('div.stack.stack--sm', [
      h('div.text-sm', { text: `${nights} night(s) total${extra > 0 ? ` · ${extra} extra` : extra < 0 ? ` · ${-extra} fewer` : ''}` }),
      extra > 0 && !check.available
        ? alert('due', check.reason, 'Another booking already holds this unit for those nights.')
        : null,
      extra > 0 && check.available
        ? h('div.text-xs.text-muted', { text: `Extra nights are charged at this booking's frozen rate of ${formatMoney(reservation.rateSnapshot ? reservation.rateSnapshot.base : reservation.rate, currency)}, not today's price.` })
        : null
    ]));
  };
  draw();

  const dialog = modal({
    title: `Extend ${reservation.code}`,
    body: h('div.stack', [
      field({ label: 'New check-out date', name: 'checkOut', type: 'date', value: newOut,
        onChange: e => { newOut = e.target.value; draw(); } }),
      info
    ]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Save',
        onclick: e => busy(e.currentTarget, async () => {
          try {
            await staysApi.changeDates(store, reservation.id, newOut);
            toastOk('Stay updated', `Now leaving ${formatDate(newOut)}`);
            dialog.close();
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ]
  });
  return dialog;
}
