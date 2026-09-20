/**
 * Guests currently in house — the prototype's In House table, now live.
 */

import { h } from '../dom.js';
import { card, dataTable, emptyState, pageHead, moneyText, filterBar, filterSelect } from '../components.js';
import { chargeForm, paymentForm } from '../forms.js';
import { inHouse } from '../../domain/reservations.js';
import { unitLabel, listUnitTypes } from '../../domain/units.js';
import { billFor } from '../../domain/folio.js';
import { formatMoney } from '../../core/money.js';
import { today, formatDate } from '../../core/dates.js';
import { printBill } from '../print-actions.js';
import { bookingDetail } from './reservations.js';

const state = { typeId: '', onlyDue: false };

export function render(ctx) {
  const { store, app } = ctx;
  const word = store.unitWord();
  const currency = store.currency();

  let rows = inHouse(store);
  if (state.typeId) rows = rows.filter(r => r.unitTypeId === state.typeId);
  if (state.onlyDue) rows = rows.filter(r => billFor(store, r).balance > 0);

  const totals = rows.reduce((acc, r) => {
    const b = billFor(store, r);
    acc.charges += b.total; acc.paid += b.paid; acc.balance += b.balance;
    acc.pax += (r.adults || 0) + (r.children || 0);
    return acc;
  }, { charges: 0, paid: 0, balance: 0, pax: 0 });

  return [
    pageHead('Guests in house', 'موجود مہمان', [
      h('button.btn', { type: 'button', text: 'Check in', onclick: () => app.go('checkin') }),
      h('button.btn.btn--primary', { type: 'button', text: 'Check out', onclick: () => app.go('checkout') })
    ]),

    filterBar([
      filterSelect('Type', state.typeId,
        [{ value: '', label: 'All types' }].concat(listUnitTypes(store).map(t => ({ value: t.id, label: t.name }))),
        v => { state.typeId = v; app.refresh(); }),
      h('label.check', [
        h('input', { type: 'checkbox', checked: state.onlyDue, onchange: e => { state.onlyDue = e.target.checked; app.refresh(); } }),
        h('span', { text: 'Only stays with a balance' })
      ]),
      h('span.push.text-sm.text-muted', { text: `${rows.length} stay(s) · ${totals.pax} guest(s)` })
    ]),

    card({ flush: true }, dataTable({
      currency,
      totals: { charges: totals.charges, paid: totals.paid, balance: totals.balance },
      totalsLabel: `${rows.length} stay(s)`,
      columns: [
        { key: 'code', label: 'S.No', render: r => h('span.mono.text-muted', { text: r.registerNo || r.code }) },
        { key: 'unit', label: word, render: r => h('span.mono.strong', { text: unitLabel(store, r.unitId) }) },
        { key: 'guest', label: 'Guest', render: r => (store.db.get('guests', r.guestId) || {}).fullName || '—' },
        { key: 'phone', label: 'Phone', render: r => h('span.mono.text-sm', { text: (store.db.get('guests', r.guestId) || {}).phone || '—' }) },
        { key: 'checkIn', label: 'In', format: 'date' },
        { key: 'checkOut', label: 'Expected out', render: r => h('span', {
            class: r.checkOut < today() ? 'money-due' : null, text: formatDate(r.checkOut) }) },
        { key: 'nights', label: 'Nt', align: 'end' },
        { key: 'pax', label: 'Pax', align: 'end', render: r => String(r.adults + r.children) },
        { key: 'charges', label: 'Charges', align: 'end', render: r => formatMoney(billFor(store, r).total, currency) },
        { key: 'paid', label: 'Paid', align: 'end', render: r => formatMoney(billFor(store, r).paid, currency) },
        { key: 'balance', label: 'Balance', align: 'end', render: r => {
            const b = billFor(store, r).balance;
            return moneyText(b, currency, b > 0 ? 'due' : 'ok');
          } },
        { key: 'act', label: 'Actions', render: r => h('div.row.row--tight', [
            store.session.can('folio.add')
              ? h('button.btn.btn--sm', { type: 'button', text: 'Charge',
                  onclick: () => chargeForm(store, { reservation: r, onSaved: () => app.refresh() }) }) : null,
            store.session.can('payment.create')
              ? h('button.btn.btn--sm', { type: 'button', text: 'Pay',
                  onclick: () => paymentForm(store, { reservation: r, onSaved: () => app.refresh() }) }) : null,
            h('button.btn.btn--sm', { type: 'button', text: 'Bill', onclick: () => printBill(store, r) }),
            store.session.can('stay.checkout')
              ? h('button.btn.btn--sm.btn--primary', { type: 'button', text: 'Out',
                  onclick: () => app.go('checkout', { reservationId: r.id }) }) : null
          ]) }
      ],
      rows,
      onRowClick: r => bookingDetail(ctx, r),
      empty: emptyState({
        title: 'Nobody is in house',
        body: 'Checked-in guests appear here with their running folio balance.',
        action: h('button.btn.btn--primary', { type: 'button', text: 'Check a guest in', onclick: () => app.go('checkin') })
      })
    }))
  ];
}
