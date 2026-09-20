/**
 * Guest directory and guest history (requirement 12).
 */

import { h } from '../dom.js';
import { card, dataTable, emptyState, pageHead, badge, moneyText, railRows, filterBar, filterSelect, reservationBadge } from '../components.js';
import { modal, confirm, ok as toastOk, fail } from '../feedback.js';
import { guestForm } from '../forms.js';
import * as guestsApi from '../../domain/guests.js';
import { unitLabel } from '../../domain/units.js';
import { billFor } from '../../domain/folio.js';
import { formatMoney } from '../../core/money.js';
import { formatDate } from '../../core/dates.js';
import { GUEST_TYPES, PAYMENT_METHODS } from '../../core/schema.js';
import { bookingDetail } from './reservations.js';

const state = { q: '', type: '', showArchived: false };

export function render(ctx) {
  const { store, app, params } = ctx;
  const currency = store.currency();

  if (params.action === 'new') { params.action = null; setTimeout(() => guestForm(store, { onSaved: () => app.refresh() }), 0); }
  if (params.guestId) {
    const g = store.db.get('guests', params.guestId);
    params.guestId = null;
    if (g) setTimeout(() => guestDetail(ctx, g), 0);
  }

  let rows = state.q
    ? guestsApi.searchGuests(store, state.q, 500)
    : guestsApi.listGuests(store, { includeArchived: state.showArchived });
  if (state.type) rows = rows.filter(g => g.guestType === state.type);
  if (!state.showArchived) rows = rows.filter(g => !g.archivedAt);

  return [
    pageHead('Guests', 'مہمان', [
      store.session.can('guest.create')
        ? h('button.btn.btn--primary', { type: 'button', text: 'New guest',
            onclick: () => guestForm(store, { onSaved: () => app.refresh() }) }) : null
    ]),

    filterBar([
      h('input.input', { placeholder: 'Search by name, CNIC or phone…', value: state.q, style: { minWidth: '240px' },
        oninput: e => { state.q = e.target.value; clearTimeout(render._t); render._t = setTimeout(() => app.refresh(), 200); } }),
      filterSelect('Type', state.type,
        [{ value: '', label: 'All types' }].concat(GUEST_TYPES.map(t => ({ value: t.id, label: t.label }))),
        v => { state.type = v; app.refresh(); }),
      h('label.check', [
        h('input', { type: 'checkbox', checked: state.showArchived, onchange: e => { state.showArchived = e.target.checked; app.refresh(); } }),
        h('span', { text: 'Show archived' })
      ]),
      h('span.push.text-sm.text-muted', { text: `${rows.length} guest(s)` })
    ]),

    card({ flush: true }, dataTable({
      currency,
      columns: [
        { key: 'code', label: 'No', render: g => h('span.mono.text-muted', { text: g.code || '—' }) },
        { key: 'fullName', label: 'Name', render: g => h('div', [
            h('div.strong', { text: g.fullName }),
            g.fullNameUr ? h('div.ur.text-xs.text-muted', { text: g.fullNameUr }) : null
          ]) },
        { key: 'cnic', label: 'CNIC / Passport', render: g => h('span.mono.text-sm', {
            text: g.cnic ? guestsApi.displayCnic(store, g.cnic) : (g.passport || '—') }) },
        { key: 'phone', label: 'Phone', render: g => h('span.mono.text-sm', { text: g.phone || '—' }) },
        { key: 'city', label: 'City' },
        { key: 'guestType', label: 'Type', render: g => badge((GUEST_TYPES.find(t => t.id === g.guestType) || {}).label || g.guestType,
            g.guestType === 'vip' ? 'accent' : g.guestType === 'blacklist' ? 'due' : 'muted') },
        { key: 'visits', label: 'Stays', align: 'end', render: g => String(store.db.where('reservations', 'guestId', g.id).length) },
        { key: 'balance', label: 'Outstanding', align: 'end', render: g => {
            const bal = store.db.where('reservations', 'guestId', g.id)
              .reduce((s, r) => s + Math.max(0, billFor(store, r).balance), 0);
            return moneyText(bal, currency, bal > 0 ? 'due' : 'ok');
          } },
        { key: 'act', label: '', render: g => h('div.row.row--tight', [
            g.archivedAt ? badge('Archived', 'muted') : null,
            store.session.can('guest.edit')
              ? h('button.btn.btn--sm', { type: 'button', text: 'Edit',
                  onclick: () => guestForm(store, { guest: g, onSaved: () => app.refresh() }) }) : null
          ]) }
      ],
      rows,
      rowClass: g => g.archivedAt ? 'is-voided' : '',
      onRowClick: g => guestDetail(ctx, g),
      empty: emptyState({
        title: state.q ? 'No guest matches' : 'No guests yet',
        body: state.q ? 'Try part of a name, a CNIC or a phone number.' : 'Guests are created here, or automatically during a walk-in check-in.',
        action: store.session.can('guest.create')
          ? h('button.btn.btn--primary', { type: 'button', text: 'New guest',
              onclick: () => guestForm(store, { prefillName: state.q, onSaved: () => app.refresh() }) }) : null
      })
    }))
  ];
}

/* ------------------------------------------------------------ guest detail */

export function guestDetail(ctx, guest) {
  const { store, app } = ctx;
  const currency = store.currency();
  const word = store.unitWord();

  const build = (dialog) => {
    const g = store.db.get('guests', guest.id) || guest;
    const stays = store.db.where('reservations', 'guestId', g.id)
      .slice().sort((a, b) => String(b.checkIn).localeCompare(String(a.checkIn)));
    const payments = store.db.where('payments', 'guestId', g.id).filter(p => !p.voided);

    let charges = 0, paid = 0, nights = 0, outstanding = 0;
    stays.forEach(r => {
      const b = billFor(store, r);
      if (r.status !== 'cancelled' && r.status !== 'no_show') {
        charges += b.total; paid += b.paid; nights += Number(r.nights) || 0;
        outstanding += Math.max(0, b.balance);
      }
    });

    dialog.body(h('div.split.split--rail-sm', [
      h('div.stack', [
        card({ title: 'Stay history', note: `${stays.length} booking(s)`, flush: true }, dataTable({
          currency, compact: true,
          columns: [
            { key: 'code', label: 'Booking', render: r => h('span.mono', { text: r.code }) },
            { key: 'unit', label: word, render: r => h('span.mono', { text: unitLabel(store, r.unitId) }) },
            { key: 'checkIn', label: 'Check-in', format: 'date' },
            { key: 'checkOut', label: 'Check-out', format: 'date' },
            { key: 'nights', label: 'Nt', align: 'end' },
            { key: 'status', label: 'Status', render: r => reservationBadge(r.status) },
            { key: 'total', label: 'Charges', align: 'end', render: r => formatMoney(billFor(store, r).total, currency) },
            { key: 'paid', label: 'Paid', align: 'end', render: r => formatMoney(billFor(store, r).paid, currency) },
            { key: 'balance', label: 'Balance', align: 'end', render: r => {
                const b = billFor(store, r).balance;
                return moneyText(b, currency, b > 0 ? 'due' : 'ok');
              } }
          ],
          rows: stays,
          onRowClick: r => { dialog.close(); bookingDetail(ctx, r); },
          empty: emptyState({ title: 'No stays yet' })
        })),

        card({ title: 'Payments', note: formatMoney(paid, currency), flush: true }, dataTable({
          currency, compact: true,
          columns: [
            { key: 'code', label: 'Receipt' },
            { key: 'at', label: 'Date', format: 'datetime' },
            { key: 'method', label: 'Method', render: p => (PAYMENT_METHODS.find(m => m.id === p.method) || {}).label || p.method },
            { key: 'kind', label: 'Type' },
            { key: 'amount', label: 'Amount', align: 'end', format: 'money' }
          ],
          rows: payments.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))),
          empty: emptyState({ title: 'No payments recorded' })
        }))
      ]),

      h('div.stack', [
        card({ title: 'Profile', tools: [badge((GUEST_TYPES.find(t => t.id === g.guestType) || {}).label || g.guestType,
          g.guestType === 'vip' ? 'accent' : g.guestType === 'blacklist' ? 'due' : 'muted')] },
          railRows([
            { k: 'Guest no', v: g.code || '—' },
            { k: 'Name', v: g.fullName },
            g.fullNameUr ? { k: 'Urdu name', v: g.fullNameUr } : null,
            g.fatherName ? { k: 'Father / husband', v: g.fatherName } : null,
            { k: 'CNIC', v: g.cnic ? guestsApi.displayCnic(store, g.cnic) : '—' },
            g.passport ? { k: 'Passport', v: g.passport } : null,
            { k: 'Phone', v: g.phone || '—' },
            g.whatsapp ? { k: 'WhatsApp', v: g.whatsapp } : null,
            g.email ? { k: 'Email', v: g.email } : null,
            { k: 'Address', v: [g.address, g.city, g.country].filter(Boolean).join(', ') || '—' },
            { k: 'First recorded', v: formatDate(String(g.createdAt).slice(0, 10)) }
          ])),

        card({ title: 'Totals' }, railRows([
          { k: 'Stays', v: String(stays.filter(r => r.status === 'checked_out' || r.status === 'checked_in').length) },
          { k: 'Nights', v: String(nights) },
          { k: 'Total charges', v: formatMoney(charges, currency) },
          { k: 'Total paid', v: formatMoney(paid, currency) },
          { k: 'Outstanding', node: moneyText(outstanding, currency, outstanding > 0 ? 'due' : 'ok') }
        ])),

        g.notes ? card({ title: 'Notes' }, h('div.text-sm', { text: g.notes })) : null,

        card({ title: 'Actions' }, h('div.stack.stack--sm', [
          store.session.can('guest.edit')
            ? h('button.btn.btn--block', { type: 'button', text: 'Edit profile',
                onclick: () => guestForm(store, { guest: g, onSaved: () => build(dialog) }) }) : null,
          store.session.can('reservation.create')
            ? h('button.btn.btn--block', { type: 'button', text: 'New booking for this guest',
                onclick: () => { dialog.close(); import('./reservations.js').then(m => m.bookingForm(store, { guestId: g.id, onSaved: () => app.refresh() })); } }) : null,
          (store.session.can('guest.archive') && !g.archivedAt)
            ? h('button.btn.btn--block', { type: 'button', text: 'Archive guest',
                onclick: async () => {
                  const usage = guestsApi.guestUsage(store, g.id);
                  const go = await confirm({
                    title: `Archive ${g.fullName}?`,
                    message: usage.reservations
                      ? `This guest has ${usage.reservations} booking(s) on record, so the profile cannot be deleted. Archiving hides it from the directory while every stay, invoice and payment stays intact.`
                      : 'The profile will be hidden from the directory. You can restore it later.',
                    confirmLabel: 'Archive', danger: true
                  });
                  if (!go) return;
                  try { await guestsApi.archiveGuest(store, g.id); toastOk('Guest archived', g.fullName); build(dialog); app.refresh(); }
                  catch (err) { fail(err); }
                } }) : null,
          (store.session.can('guest.edit') && g.archivedAt)
            ? h('button.btn.btn--block', { type: 'button', text: 'Restore guest',
                onclick: async () => {
                  try { await guestsApi.restoreGuest(store, g.id); toastOk('Guest restored', g.fullName); build(dialog); app.refresh(); }
                  catch (err) { fail(err); }
                } }) : null
        ]))
      ])
    ]));
  };

  const dialog = modal({
    title: guest.fullName,
    subtitle: guest.code,
    size: 'xwide',
    footer: [h('button.btn.btn--primary', { type: 'button', text: 'Close', onclick: () => dialog.close() })]
  });
  build(dialog);
  return dialog;
}
