/**
 * Reception dashboard (requirement 4).
 *
 * Practical, not decorative: what is arriving, what is leaving, what is owed,
 * and one click to act on any of it.
 */

import { h } from '../dom.js';
import { kpi, card, dataTable, emptyState, statusStrip, badge, moneyText, pageHead, unitStatusColor, alert } from '../components.js';
import { dashboardData } from '../../domain/dashboard.js';
import { formatMoney } from '../../core/money.js';
import { formatDate, formatTime, formatDateLong, today } from '../../core/dates.js';
import { methodName } from '../../domain/payments.js';

export function render(ctx) {
  const { store, app } = ctx;
  const d = dashboardData(store, today());
  const currency = store.currency();
  const word = store.unitWord();

  const quickActions = [
    { label: 'New booking', key: '', screen: 'reservations', params: { action: 'new' }, perm: 'reservation.create' },
    { label: 'Walk-in check-in', key: 'F2', screen: 'checkin', params: {}, perm: 'stay.checkin' },
    { label: 'Check out', key: 'F4', screen: 'checkout', params: {}, perm: 'stay.checkout' },
    { label: 'Add guest', key: '', screen: 'guests', params: { action: 'new' }, perm: 'guest.create' },
    { label: 'Add ' + word.toLowerCase(), key: '', screen: 'units', params: { action: 'new' }, perm: 'unit.create' },
    { label: 'Take payment', key: '', screen: 'payments', params: { action: 'new' }, perm: 'payment.create' },
    { label: 'Print register', key: 'F8', screen: 'register', params: {}, perm: 'view.register' }
  ].filter(a => !a.perm || store.session.can(a.perm));

  return [
    pageHead('Dashboard', 'ڈیش بورڈ — آج کا خلاصہ', [
      store.session.can('stay.checkin')
        ? h('button.btn.btn--primary', { type: 'button', text: 'Check in guest', onclick: () => app.go('checkin') }) : null,
      store.session.can('view.register')
        ? h('button.btn', { type: 'button', text: 'Print register', onclick: () => app.go('register') }) : null
    ]),

    h('div.text-sm.text-muted', { text: formatDateLong(d.date) }),

    store.db.degraded ? alert('warn', 'Limited storage in use',
      'This browser is not allowing the full local database, so data is being kept in browser storage instead. It still works, but take a backup from Settings regularly.') : null,

    /* KPI row */
    h('div.kpi-grid', [
      kpi({ label: 'Total ' + word.toLowerCase() + 's', value: String(d.totals.units),
            sub: `${d.occupancy}% occupancy`, onClick: () => app.go('units') }),
      kpi({ label: 'Available', value: String(d.totals.available), tone: 'ok',
            sub: `${d.totals.ready} ready to sell`, onClick: () => app.go('units', { status: 'available' }) }),
      kpi({ label: 'Reserved', value: String(d.totals.reserved), tone: 'accent',
            sub: 'held for arrivals', onClick: () => app.go('units', { status: 'reserved' }) }),
      kpi({ label: 'Occupied', value: String(d.totals.occupied), tone: 'river',
            sub: `${d.occupiedList.length} stay(s) in house`, onClick: () => app.go('inhouse') }),
      kpi({ label: 'Cleaning', value: String(d.totals.cleaning),
            sub: 'housekeeping queue', onClick: () => app.go('housekeeping') }),
      kpi({ label: 'Maintenance', value: String(d.totals.maintenance + d.totals.blocked),
            sub: 'out of service', onClick: () => app.go('units', { status: 'maintenance' }) })
    ]),

    h('div.kpi-grid', [
      kpi({ label: "Today's arrivals", value: String(d.arrivals.length),
            sub: `${d.arrivals.filter(a => a.reservation.status === 'reserved').length} still expected`,
            onClick: () => app.go('checkin') }),
      kpi({ label: "Today's departures", value: String(d.departures.length),
            sub: d.overdueList.length ? `${d.overdueList.length} overdue` : 'none overdue',
            tone: d.overdueList.length ? 'due' : undefined,
            onClick: () => app.go('checkout') }),
      kpi({ label: 'Expected revenue', value: formatMoney(d.expectedRevenue, currency),
            sub: "tonight's rooms at booked rates" }),
      kpi({ label: "Today's collection", value: formatMoney(d.collection, currency), tone: 'ok',
            sub: methodSummary(d.collectionByMethod, currency),
            onClick: () => app.go('payments') }),
      kpi({ label: 'Outstanding balance', value: formatMoney(d.outstanding, currency),
            tone: d.outstanding > 0 ? 'due' : undefined,
            sub: `${d.outstandingCount} guest(s)`,
            onClick: () => app.go('reports', { report: 'outstanding' }) }),
      kpi({ label: 'Cash in hand', value: formatMoney(d.figures.closingCash, currency),
            sub: d.figures.locked ? 'day closed' : 'day not closed',
            onClick: () => store.session.can('day.close') ? app.go('closing') : null })
    ]),

    /* Arrivals / departures / status */
    h('div.split.split--auto', [
      card({ title: 'Arrivals today', note: `${d.arrivals.length} expected` },
        d.arrivals.length
          ? h('div.stack.stack--sm', d.arrivals.map(a => arrivalRow(a, app, store, currency)))
          : emptyState({ title: 'No arrivals today', body: 'Bookings starting today will appear here.' })),

      card({ title: 'Departures today', note: `${d.departures.length} due out` },
        d.departures.length
          ? h('div.stack.stack--sm', d.departures.map(x => departureRow(x, app, store, currency)))
          : emptyState({ title: 'No departures today', body: 'Stays ending today will appear here.' })),

      card({ title: word + ' status' }, statusStrip([
        { label: 'Available', count: d.totals.available, color: unitStatusColor('available'), id: 'available' },
        { label: 'Occupied', count: d.totals.occupied, color: unitStatusColor('occupied'), id: 'occupied' },
        { label: 'Reserved', count: d.totals.reserved, color: unitStatusColor('reserved'), id: 'reserved' },
        { label: 'Cleaning', count: d.totals.cleaning, color: unitStatusColor('cleaning'), id: 'cleaning' },
        { label: 'Maintenance', count: d.totals.maintenance, color: unitStatusColor('maintenance'), id: 'maintenance' },
        { label: 'Blocked', count: d.totals.blocked, color: unitStatusColor('blocked'), id: 'blocked' }
      ], item => app.go('units', { status: item.id })))
    ]),

    /* Overdue warning */
    d.overdueList.length ? card({ title: 'Overdue departures', note: 'past their check-out date' },
      dataTable({
        currency, compact: true,
        columns: [
          { key: 'guestName', label: 'Guest' },
          { key: 'unitCode', label: word },
          { key: 'due', label: 'Was due', render: r => formatDate(r.reservation.checkOut) },
          { key: 'balance', label: 'Balance', align: 'end', render: r => moneyText(r.balance, currency, 'due') },
          { key: 'act', label: '', render: r => h('button.btn.btn--sm.btn--primary', {
              type: 'button', text: 'Check out', onclick: () => app.go('checkout', { reservationId: r.reservation.id }) }) }
        ],
        rows: d.overdueList
      })) : null,

    /* Occupied + recent + quick actions */
    h('div.split.split--wide', [
      h('div.stack', [
        card({ title: 'In house now', note: `${d.occupiedList.length} stay(s)`, flush: true,
               tools: [h('button.btn.btn--sm', { type: 'button', text: 'Open', onclick: () => app.go('inhouse') })] },
          dataTable({
            currency, compact: true,
            columns: [
              { key: 'unitCode', label: word, render: r => h('span.mono.strong', { text: r.unitCode }) },
              { key: 'guestName', label: 'Guest' },
              { key: 'out', label: 'Due out', render: r => h('span', {
                  class: r.overdue ? 'money-due' : null, text: formatDate(r.reservation.checkOut) }) },
              { key: 'nightsLeft', label: 'Nights left', align: 'end' },
              { key: 'balance', label: 'Balance', align: 'end',
                render: r => moneyText(r.balance, currency, r.balance > 0 ? 'due' : 'ok') }
            ],
            rows: d.occupiedList,
            onRowClick: r => app.go('checkout', { reservationId: r.reservation.id }),
            empty: emptyState({ title: 'Nobody is checked in', body: 'Check a guest in to see them here.' })
          })),

        card({ title: 'Recent activity', titleUr: 'روزنامچہ', flush: true },
          dataTable({
            currency, compact: true,
            columns: [
              { key: 'sno', label: 'No', render: r => h('span.mono.text-muted', { text: r.sno || '—' }) },
              { key: 'time', label: 'Time', render: r => h('span.mono', { text: formatTime(r.at) }) },
              { key: 'guest', label: 'Guest' },
              { key: 'unit', label: word, render: r => h('span.mono', { text: r.unit }) },
              { key: 'kind', label: 'Movement', render: r => badge(r.kind, movementTone(r.kind)) },
              { key: 'amount', label: 'Amount', align: 'end', format: 'money' }
            ],
            rows: d.recent,
            empty: emptyState({ title: 'No activity yet', body: 'Check-ins, check-outs and payments appear here.' })
          }))
      ]),

      h('div.stack', [
        card({ title: 'Quick actions' },
          h('div.stack.stack--sm', quickActions.map(a =>
            h('button.btn.btn--block', {
              type: 'button',
              style: { justifyContent: 'space-between' },
              onclick: () => app.go(a.screen, a.params)
            }, [h('span', { text: a.label }), a.key ? h('span.btn__key', { text: a.key }) : null])))),

        card({ title: "Today's collection", note: formatMoney(d.collection, currency) },
          h('div.totals', d.collectionByMethod && Object.keys(d.collectionByMethod).some(k => d.collectionByMethod[k])
            ? Object.keys(d.collectionByMethod).filter(k => d.collectionByMethod[k])
                .map(k => h('div.totals__row', [
                  h('span.totals__label', { text: methodName(k) }),
                  h('span.totals__value', { text: formatMoney(d.collectionByMethod[k], currency) })
                ]))
                .concat([h('div.totals__row.totals__row--rule.totals__row--grand', [
                  h('span.totals__label', { text: 'Net' }),
                  h('span.totals__value', { text: formatMoney(d.collection, currency) })
                ])])
            : [h('div.text-muted.text-sm', { text: 'No payments recorded today.' })]))
      ])
    ])
  ];
}

function methodSummary(byMethod, currency) {
  const parts = Object.keys(byMethod || {})
    .filter(k => byMethod[k])
    .slice(0, 2)
    .map(k => `${methodName(k)} ${formatMoney(byMethod[k], currency).replace(/^\D+\s*/, '')}`);
  return parts.join(' · ') || 'nothing yet';
}

function movementTone(kind) {
  return kind === 'In' ? 'ok' : kind === 'Out' ? 'river' : kind === 'Refund' ? 'due' : 'accent';
}

function arrivalRow(a, app, store, currency) {
  return h('div.row', { style: { padding: '9px 0', borderBottom: '1px solid var(--line-soft)' } }, [
    h('div', { style: { minWidth: 0, flex: '1' } }, [
      h('div.strong.truncate', { text: a.guestName }),
      h('div.mono.text-xs.text-muted', {
        text: [a.unitCode, a.phone, `${a.reservation.nights} night(s)`].filter(Boolean).join(' · ')
      })
    ]),
    a.reservation.status === 'checked_in'
      ? badge('Checked in', 'river')
      : h('button.btn.btn--sm', { type: 'button', text: 'Check in',
          onclick: () => app.go('checkin', { reservationId: a.reservation.id }) })
  ]);
}

function departureRow(x, app, store, currency) {
  return h('div.row', { style: { padding: '9px 0', borderBottom: '1px solid var(--line-soft)' } }, [
    h('div', { style: { minWidth: 0, flex: '1' } }, [
      h('div.row.row--tight', [
        h('span.strong.truncate', { text: x.guestName }),
        x.overdue ? badge('Overdue', 'due') : null
      ]),
      h('div.mono.text-xs.text-muted', {
        text: [x.unitCode, `in ${formatDate(x.reservation.checkIn)}`, `${x.reservation.adults + x.reservation.children} person(s)`].join(' · ')
      })
    ]),
    h('div', { style: { textAlign: 'end' } }, [
      moneyText(x.balance, currency, x.balance > 0 ? 'due' : 'ok'),
      h('div', { style: { marginTop: '5px' } },
        x.reservation.status === 'checked_out'
          ? badge('Checked out', 'muted')
          : h('button.btn.btn--sm', { type: 'button', text: 'Check out',
              onclick: () => app.go('checkout', { reservationId: x.reservation.id }) }))
    ])
  ]);
}
