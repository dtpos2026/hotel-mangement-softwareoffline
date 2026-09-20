/**
 * Restaurant point of sale.
 *
 * Two views: a floor plan of tables, and the order screen for whichever table
 * is open. The floor plan is the same visual idiom used for the room board, so
 * staff who can read one can read the other.
 */

import { h, mount, qs, busy } from '../dom.js';
import { card, dataTable, emptyState, pageHead, badge, alert, filterBar, filterSelect, totalsRail, field, chipGroup } from '../components.js';
import { modal, promptText, toast, ok as toastOk, fail } from '../feedback.js';
import * as r from '../../domain/restaurant.js';
import { inHouse } from '../../domain/reservations.js';
import { unitLabel } from '../../domain/units.js';
import { formatMoney } from '../../core/money.js';
import { formatTime, today } from '../../core/dates.js';
import { PAYMENT_METHODS } from '../../core/schema.js';
import { printKitchenSlip, printOrderBill } from '../print-actions.js';

const state = { area: '', orderId: '', view: 'floor', search: '', categoryId: '' };

export function render(ctx) {
  const { store, app, params } = ctx;

  if (!r.isEnabled(store)) {
    return [
      pageHead('Restaurant', 'ریسٹورنٹ', []),
      card({}, emptyState({
        title: 'The restaurant module is switched off',
        body: 'Turn it on in Settings → Restaurant to take table orders, print kitchen slips and post food to room bills.',
        action: store.session.can('settings.manage')
          ? h('button.btn.btn--primary', { type: 'button', text: 'Open restaurant settings',
              onclick: () => app.go('settings', { tab: 'restaurant' }) })
          : null
      }))
    ];
  }

  if (params.orderId) { state.orderId = params.orderId; state.view = 'order'; params.orderId = null; }

  const current = state.orderId ? store.db.get('orders', state.orderId) : null;
  if (current && (current.status === 'paid' || current.status === 'cancelled')) {
    state.orderId = ''; state.view = 'floor';
  }

  return state.view === 'order' && state.orderId
    ? orderView(ctx, store.db.get('orders', state.orderId))
    : floorView(ctx);
}

/* --------------------------------------------------------- floor plan */

function floorView(ctx) {
  const { store, app } = ctx;
  const currency = store.currency();
  const areas = r.areasOf(store);
  const plan = r.floorPlan(store, state.area || undefined);
  const open = r.openOrders(store);
  const tables = r.listTables(store);

  const takings = r.salesSummary(store, today(), today());

  const head = pageHead('Restaurant', 'ریسٹورنٹ', [
    h('button.btn', { type: 'button', text: 'Takeaway order',
      onclick: () => startOrder(ctx, { type: 'takeaway' }) }),
    h('button.btn', { type: 'button', text: 'Room order',
      onclick: () => roomOrderDialog(ctx) }),
    store.session.can('settings.manage')
      ? h('button.btn', { type: 'button', text: 'Menu & tables', onclick: () => app.go('settings', { tab: 'restaurant' }) })
      : null
  ]);

  if (!tables.length) {
    return [head, card({}, emptyState({
      title: 'No tables set up yet',
      body: 'Add your tables in Settings → Restaurant, then they appear here as a floor plan.',
      action: store.session.can('settings.manage')
        ? h('button.btn.btn--primary', { type: 'button', text: 'Set up tables',
            onclick: () => app.go('settings', { tab: 'restaurant' }) })
        : null
    }))];
  }

  return [
    head,

    h('div.kpi-grid', [
      kpiTile('Tables free', String(plan.filter(p => p.status === 'free').length), 'ok'),
      kpiTile('Seated', String(plan.filter(p => p.status === 'seated').length), 'river'),
      kpiTile('Awaiting payment', String(plan.filter(p => p.status === 'billed').length), 'accent'),
      kpiTile('Open orders', String(open.length)),
      kpiTile("Today's orders", String(takings.orders)),
      kpiTile("Today's sales", formatMoney(takings.total, currency), 'ok')
    ]),

    areas.length > 1 ? filterBar([
      h('span.filters__label', { text: 'Area' }),
      filterSelect('', state.area,
        [{ value: '', label: 'All areas' }].concat(areas.map(a => ({ value: a, label: a }))),
        v => { state.area = v; app.refresh(); })
    ]) : null,

    // The floor plan itself, grouped by area.
    h('div.stack', groupBy(plan, p => p.table.area).map(([area, group]) =>
      card({ title: area, note: `${group.filter(g => g.status !== 'free').length} of ${group.length} in use` },
        h('div.table-grid', group.map(entry => tableCard(ctx, entry)))))),

    open.length ? card({ title: 'Open orders', flush: true }, dataTable({
      currency, compact: true,
      columns: [
        { key: 'code', label: 'Order', render: o => h('span.mono.strong', { text: o.code }) },
        { key: 'where', label: 'Where', render: o => o.type === 'table'
            ? 'Table ' + ((store.db.get('tables', o.tableId) || {}).code || '—')
            : o.type === 'room'
              ? 'Room ' + unitLabel(store, (store.db.get('reservations', o.reservationId) || {}).unitId)
              : 'Takeaway' },
        { key: 'covers', label: 'Covers', align: 'end' },
        { key: 'items', label: 'Items', align: 'end', render: o => String(r.linesFor(store, o.id).length) },
        { key: 'opened', label: 'Opened', render: o => formatTime(o.openedAt) },
        { key: 'waiter', label: 'Waiter' },
        { key: 'status', label: 'Status', render: o => orderBadge(o.status) },
        { key: 'total', label: 'Total', align: 'end', render: o => formatMoney(r.billFor(store, o).total, currency) }
      ],
      rows: open,
      onRowClick: o => { state.orderId = o.id; state.view = 'order'; app.refresh(); }
    })) : null
  ];
}

function kpiTile(label, value, tone) {
  return h('div.kpi' + (tone ? '.kpi--' + tone : ''), [
    h('div.kpi__label', { text: label }),
    h('div.kpi__value', { text: value })
  ]);
}

function tableCard(ctx, entry) {
  const { store, app } = ctx;
  const currency = store.currency();
  const { table, order, bill, status } = entry;

  const guestLine = order
    ? (order.covers ? `${order.covers} cover(s)` : '') + (order.waiter ? ' · ' + order.waiter : '')
    : `${table.seats} seat(s)`;

  return h('button.table-card', {
    type: 'button',
    'data-status': status,
    'data-shape': table.shape || 'square',
    title: `Table ${table.code} — ${status}`,
    onclick: () => {
      if (order) { state.orderId = order.id; state.view = 'order'; app.refresh(); }
      else startOrder(ctx, { type: 'table', tableId: table.id });
    }
  }, [
    h('div.table-card__top', [
      h('span.table-card__code', { text: table.code }),
      h('span.table-card__seats', { text: String(table.seats) })
    ]),
    h('div.table-card__status', { text: status === 'free' ? 'Free' : status === 'seated' ? 'Seated' : status === 'billed' ? 'Bill out' : 'Reserved' }),
    h('div.table-card__meta', { text: guestLine }),
    order ? h('div.table-card__total', { text: formatMoney(bill.total, currency) }) : h('div.table-card__total', { html: '&nbsp;' }),
    order ? h('div.table-card__since', { text: 'since ' + formatTime(order.openedAt) }) : null
  ]);
}

function groupBy(list, keyOf) {
  const map = new Map();
  list.forEach(item => {
    const k = keyOf(item) || '—';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  });
  return Array.from(map.entries());
}

function orderBadge(status) {
  const tone = { open: 'warn', served: 'river', billed: 'accent', paid: 'ok', cancelled: 'muted' }[status] || 'muted';
  const label = { open: 'Open', served: 'Served', billed: 'Billed', paid: 'Paid', cancelled: 'Cancelled' }[status] || status;
  return badge(label, tone);
}

async function startOrder(ctx, patch) {
  const { store, app } = ctx;
  try {
    const order = await r.openOrder(store, patch);
    state.orderId = order.id;
    state.view = 'order';
    app.refresh();
  } catch (err) { fail(err); }
}

function roomOrderDialog(ctx) {
  const { store } = ctx;
  const stays = inHouse(store);
  if (!stays.length) { toast('warn', 'Nobody is checked in', 'A room order needs a guest in the room.'); return; }

  let chosen = stays[0].id;
  const box = h('div');
  const draw = () => mount(box, h('div.chips', stays.map(s => {
    const guest = store.db.get('guests', s.guestId);
    return h('button.chip', {
      type: 'button', class: s.id === chosen ? 'is-on' : null,
      onclick: () => { chosen = s.id; draw(); }
    }, [
      h('span.mono.strong', { text: unitLabel(store, s.unitId) }),
      h('span.text-xs', { style: { opacity: 0.75, marginInlineStart: '6px' }, text: guest ? guest.fullName : '' })
    ]);
  })));
  draw();

  const dialog = modal({
    title: 'Room service order',
    subtitle: 'The bill can be posted to the room at the end.',
    body: h('div.field', [h('div.field__label', { text: 'Which room?' }), box]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Start order',
        onclick: e => busy(e.currentTarget, async () => {
          dialog.close();
          await startOrder(ctx, { type: 'room', reservationId: chosen });
        }) })
    ]
  });
}

/* -------------------------------------------------------- order screen */

function orderView(ctx, order) {
  const { store, app } = ctx;
  const currency = store.currency();
  if (!order) { state.view = 'floor'; return floorView(ctx); }

  const categories = r.listCategories(store);
  const items = r.listMenuItems(store, {
    availableOnly: true,
    categoryId: state.categoryId || undefined,
    search: state.search || undefined
  });
  const lines = r.linesFor(store, order.id);
  const bill = r.billFor(store, order);
  const where = describeOrder(store, order);
  const cfg = r.settings(store);

  const menuBox = h('div');
  const drawMenu = () => mount(menuBox, items.length
    ? h('div.menu-grid', items.map(item => h('button.menu-item', {
        type: 'button',
        style: { '--cat': (store.db.get('menuCategories', item.categoryId) || {}).colour || 'var(--accent)' },
        onclick: async () => {
          try { await r.addLine(store, order.id, { menuItemId: item.id, qty: 1 }); }
          catch (err) { fail(err); }
        }
      }, [
        h('span.menu-item__name', { text: item.name }),
        item.nameUr ? h('span.menu-item__ur.ur', { text: item.nameUr }) : null,
        h('span.menu-item__price', { text: formatMoney(item.price, currency) })
      ])))
    : emptyState({ title: 'No items match', body: 'Clear the search, or add items in Settings → Restaurant.' }));
  drawMenu();

  return [
    pageHead(`Order ${order.code}`, where.title, [
      h('button.btn', { type: 'button', text: '‹ Floor plan',
        onclick: () => { state.view = 'floor'; state.orderId = ''; app.refresh(); } })
    ]),

    h('div.split.split--rail', [
      h('div.stack', [
        filterBar([
          h('input.input', { placeholder: 'Search the menu…', value: state.search, style: { minWidth: '200px' },
            oninput: e => { state.search = e.target.value; clearTimeout(orderView._t); orderView._t = setTimeout(() => app.refresh(), 200); } }),
          h('div.chips', [
            h('button.chip', { type: 'button', class: !state.categoryId ? 'is-on' : null, text: 'All',
              onclick: () => { state.categoryId = ''; app.refresh(); } })
          ].concat(categories.map(c => h('button.chip', {
            type: 'button',
            class: c.id === state.categoryId ? 'is-on' : null,
            style: c.id === state.categoryId ? { borderColor: c.colour, color: c.colour, background: c.colour + '14' } : null,
            text: c.name,
            onclick: () => { state.categoryId = c.id; app.refresh(); }
          }))))
        ]),
        card({ title: 'Menu', flush: true }, h('div', { style: { padding: '12px' } }, menuBox))
      ]),

      h('aside.rail', h('div.stack', [
        card({
          title: where.label,
          note: `${lines.length} item(s)`,
          tools: [orderBadge(order.status)]
        }, h('div.stack', [
          lines.length ? h('div.order-lines', lines.map(line => orderLineRow(ctx, order, line))) 
            : h('div.text-sm.text-muted', { text: 'Tap a menu item to add it.' }),

          h('div', { style: { borderTop: '1px solid var(--line)', paddingTop: '10px' } },
            totalsRail([
              { label: 'Subtotal', value: bill.gross },
              bill.discount ? { label: bill.discountLabel, value: -bill.discount } : null,
              bill.service ? { label: `Service ${bill.servicePercent}%`, value: bill.service } : null,
              bill.taxAmount ? { label: `${bill.tax.name} ${bill.tax.percent}%`, value: bill.taxAmount } : null,
              { label: 'Total', value: bill.total, rule: true, kind: 'grand' }
            ], currency))
        ])),

        card({ title: 'Actions' }, h('div.stack.stack--sm', [
          h('button.btn.btn--block', { type: 'button', text: 'Send to kitchen',
            disabled: !lines.some(l => l.status === 'pending'),
            onclick: e => busy(e.currentTarget, async () => {
              try {
                const result = await r.sendToKitchen(store, order.id);
                if (!result.sent.length) { toast('info', 'Nothing new for the kitchen'); return; }
                toastOk('Sent to kitchen', `${result.sent.length} item(s)`);
                if (cfg.printKitchenSlip) printKitchenSlip(store, order, result.sent);
              } catch (err) { fail(err); }
            }) }),

          h('button.btn.btn--block', { type: 'button', text: 'Mark served',
            disabled: !lines.length || order.status === 'served',
            onclick: e => busy(e.currentTarget, async () => {
              try { await r.markServed(store, order.id); toastOk('Marked served'); }
              catch (err) { fail(err); }
            }) }),

          h('button.btn.btn--block', { type: 'button', text: 'Discount',
            disabled: !lines.length,
            onclick: () => discountDialog(ctx, order) }),

          h('button.btn.btn--block', { type: 'button', text: 'Print bill',
            disabled: !lines.length,
            onclick: async () => {
              try { if (order.status === 'open' || order.status === 'served') await r.billOrder(store, order.id); }
              catch (err) { fail(err); return; }
              printOrderBill(store, store.db.get('orders', order.id));
            } }),

          h('button.btn.btn--primary.btn--block.btn--lg', { type: 'button', text: 'Take payment',
            disabled: !lines.length,
            onclick: () => settleDialog(ctx, order) }),

          (cfg.allowPostToRoom && store.session.can('folio.add'))
            ? h('button.btn.btn--block', { type: 'button', text: 'Post to a room bill',
                disabled: !lines.length,
                onclick: () => postDialog(ctx, order) })
            : null,

          h('button.btn.btn--danger.btn--block', { type: 'button', text: 'Cancel order',
            onclick: async () => {
              const reason = await promptText({
                title: `Cancel order ${order.code}?`, label: 'Reason',
                placeholder: 'Guest left without ordering', danger: true, confirmLabel: 'Cancel order'
              });
              if (reason === null) return;
              try {
                await r.cancelOrder(store, order.id, reason);
                toastOk('Order cancelled');
                state.view = 'floor'; state.orderId = '';
                app.refresh();
              } catch (err) { fail(err); }
            } })
        ]))
      ]))
    ])
  ];
}

function describeOrder(store, order) {
  if (order.type === 'table') {
    const table = store.db.get('tables', order.tableId);
    return { label: 'Table ' + (table ? table.code : '—'), title: table ? `${table.area} · ${table.seats} seats` : '' };
  }
  if (order.type === 'room') {
    const stay = store.db.get('reservations', order.reservationId);
    const guest = stay ? store.db.get('guests', stay.guestId) : null;
    return {
      label: 'Room ' + (stay ? unitLabel(store, stay.unitId) : '—'),
      title: guest ? guest.fullName : ''
    };
  }
  return { label: 'Takeaway', title: '' };
}

function orderLineRow(ctx, order, line) {
  const { store } = ctx;
  const currency = store.currency();
  const locked = order.postedToFolio || order.status === 'paid';

  return h('div.order-line', [
    h('div.order-line__main', [
      h('div.order-line__name', [
        line.name,
        line.status === 'sent' ? h('span.order-line__flag', { title: 'Sent to the kitchen', text: '↗' }) : null
      ]),
      line.notes ? h('div.order-line__note', { text: line.notes }) : null
    ]),
    h('div.order-line__qty', locked ? h('span.mono', { text: '× ' + line.qty }) : [
      h('button.qty-btn', { type: 'button', text: '−', title: 'One fewer',
        onclick: async () => { try { await r.changeLineQty(store, line.id, line.qty - 1); } catch (err) { fail(err); } } }),
      h('span.mono.qty-val', { text: String(line.qty) }),
      h('button.qty-btn', { type: 'button', text: '+', title: 'One more',
        onclick: async () => { try { await r.changeLineQty(store, line.id, line.qty + 1); } catch (err) { fail(err); } } })
    ]),
    h('div.order-line__amount.mono', { text: formatMoney(line.amount, currency) }),
    locked ? null : h('button.order-line__x', {
      type: 'button', title: 'Remove', text: '×',
      onclick: async () => {
        try {
          if (line.status === 'sent') {
            const reason = await promptText({
              title: 'Remove ' + line.name + '?',
              label: 'Reason',
              hint: 'This item has already gone to the kitchen, so it was probably cooked.',
              danger: true, confirmLabel: 'Remove'
            });
            if (reason === null) return;
            await r.voidLine(store, line.id, reason);
          } else {
            await r.voidLine(store, line.id, '');
          }
        } catch (err) { fail(err); }
      }
    })
  ]);
}

function discountDialog(ctx, order) {
  const { store } = ctx;
  let type = order.discountType || 'amount';
  const typeBox = h('div');
  const draw = () => mount(typeBox, chipGroup({
    options: [{ value: 'amount', label: 'Fixed amount' }, { value: 'percent', label: 'Percent' }],
    value: type, onChange: v => { type = v; draw(); }
  }));
  draw();

  const dialog = modal({
    title: 'Discount on ' + order.code,
    body: h('div.stack', [
      h('div.field', [h('div.field__label', { text: 'Type' }), typeBox]),
      field({ label: 'Amount', name: 'discount', type: 'number', min: 0, value: order.discount || 0, autofocus: true })
    ]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Apply',
        onclick: e => busy(e.currentTarget, async () => {
          const value = Number((qs('[name="discount"]', dialog.el) || {}).value) || 0;
          try {
            await r.setDiscount(store, order.id, value, type);
            toastOk('Discount applied');
            dialog.close();
          } catch (err) { fail(err); }
        }) })
    ]
  });
}

function settleDialog(ctx, order) {
  const { store, app } = ctx;
  const currency = store.currency();
  const bill = r.billFor(store, order);
  let method = 'cash';
  const methodBox = h('div');
  const draw = () => mount(methodBox, chipGroup({
    options: PAYMENT_METHODS.map(m => ({ value: m.id, label: m.label })),
    value: method, onChange: v => { method = v; draw(); }
  }));
  draw();

  const dialog = modal({
    title: 'Take payment',
    subtitle: `${order.code} · ${formatMoney(bill.total, currency)}`,
    body: h('div.stack', [
      totalsRail([
        { label: 'Subtotal', value: bill.gross },
        bill.discount ? { label: bill.discountLabel, value: -bill.discount } : null,
        bill.service ? { label: `Service ${bill.servicePercent}%`, value: bill.service } : null,
        bill.taxAmount ? { label: `${bill.tax.name} ${bill.tax.percent}%`, value: bill.taxAmount } : null,
        { label: 'Total due', value: bill.total, rule: true, kind: 'grand' }
      ], currency),
      h('div.field', [h('div.field__label', { text: 'Paid by' }), methodBox]),
      field({ label: 'Reference', name: 'reference', placeholder: 'Transaction number' })
    ]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Mark as paid',
        onclick: e => busy(e.currentTarget, async () => {
          try {
            const reference = (qs('[name="reference"]', dialog.el) || {}).value || '';
            const result = await r.settleOrder(store, order.id, { method, reference });
            toastOk('Paid', `${result.payment.code} · ${formatMoney(result.bill.total, currency)}`);
            dialog.close();
            printOrderBill(store, result.order);
            state.view = 'floor'; state.orderId = '';
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ]
  });
}

function postDialog(ctx, order) {
  const { store, app } = ctx;
  const currency = store.currency();
  const stays = inHouse(store);
  if (!stays.length) { toast('warn', 'Nobody is checked in', 'There is no room bill to post this to.'); return; }

  const bill = r.billFor(store, order);
  let chosen = order.reservationId || stays[0].id;
  const box = h('div');
  const draw = () => mount(box, h('div.chips', stays.map(s => {
    const guest = store.db.get('guests', s.guestId);
    return h('button.chip', {
      type: 'button', class: s.id === chosen ? 'is-on' : null,
      onclick: () => { chosen = s.id; draw(); }
    }, [
      h('span.mono.strong', { text: unitLabel(store, s.unitId) }),
      h('span.text-xs', { style: { opacity: 0.75, marginInlineStart: '6px' }, text: guest ? guest.fullName : '' })
    ]);
  })));
  draw();

  const dialog = modal({
    title: 'Post to a room bill',
    subtitle: `${order.code} · ${formatMoney(bill.total, currency)}`,
    body: h('div.stack', [
      h('div.field', [h('div.field__label', { text: 'Which room?' }), box]),
      alert('info', 'How this is charged',
        'The food goes onto the room bill and is settled at check-out. The amount added is before tax, because the room bill adds the property tax itself — so the guest is never taxed twice.')
    ]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Post to room',
        onclick: e => busy(e.currentTarget, async () => {
          try {
            const result = await r.postToRoom(store, order.id, chosen);
            toastOk('Posted to the room bill', `${unitLabel(store, (store.db.get('reservations', chosen) || {}).unitId)} · ${formatMoney(result.bill.total, currency)}`);
            dialog.close();
            state.view = 'floor'; state.orderId = '';
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ]
  });
}
