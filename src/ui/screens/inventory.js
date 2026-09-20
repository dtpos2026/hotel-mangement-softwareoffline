/**
 * Stock and purchasing.
 *
 * Three tabs, because three different people use this screen: the storekeeper
 * looks at what is on the shelves, the manager records what arrived, and
 * whoever pays the bills looks at the suppliers. Each opens on what that
 * person came for.
 */

import { h, mount, qs, formValues, applyErrors, busy } from '../dom.js';
import {
  card, dataTable, emptyState, pageHead, kpi, badge, field, filterBar,
  filterSelect, segmented, rangePicker, alert, railRows
} from '../components.js';
import { modal, confirm, ok as toastOk, fail } from '../feedback.js';
import * as inv from '../../domain/inventory.js';
import { STOCK_UNITS, STOCK_CATEGORIES, STOCK_REASONS } from '../../core/schema.js';
import { formatMoney, toMoney } from '../../core/money.js';
import { presetRange, today, formatDate } from '../../core/dates.js';
import { toCsv, downloadFile } from '../../core/backup.js';

const state = {
  tab: 'stock',
  search: '',
  category: '',
  lowOnly: false,
  preset: 'month',
  from: presetRange('month').from,
  to: presetRange('month').to,
  selectedItemId: ''
};

export function render(ctx) {
  const { store, app } = ctx;
  const canManage = store.session.can('stock.manage');
  const canBuy = store.session.can('purchase.create');
  const sum = inv.summary(store);
  const currency = store.currency();

  return [
    pageHead('Stock', 'اسٹاک', [
      state.tab === 'stock' && canManage
        ? h('button.btn', { type: 'button', text: 'Add item', onclick: () => itemForm(ctx) }) : null,
      state.tab === 'stock' && store.session.can('stock.move')
        ? h('button.btn', { type: 'button', text: 'Record movement', onclick: () => moveForm(ctx) }) : null,
      state.tab === 'suppliers' && canManage
        ? h('button.btn', { type: 'button', text: 'Add supplier', onclick: () => supplierForm(ctx) }) : null,
      state.tab === 'purchases' && canBuy
        ? h('button.btn.btn--primary', { type: 'button', text: 'Record purchase', onclick: () => purchaseForm(ctx) }) : null
    ]),

    h('div.kpi-grid', [
      kpi({ label: 'Items tracked', value: String(sum.items) }),
      kpi({ label: 'Stock value', value: formatMoney(sum.stockValue, currency) }),
      kpi({ label: 'Need ordering', value: String(sum.lowCount), tone: sum.lowCount ? 'warn' : null }),
      kpi({ label: 'Owed to suppliers', value: formatMoney(sum.suppliersOwed, currency),
        tone: sum.suppliersOwed ? 'due' : null })
    ]),

    sum.lowCount
      ? alert('warn', sum.lowCount + ' item(s) at or below the reorder level',
          sum.lowItems.map(i => `${i.name} — ${i.qty} ${i.unit} left (reorder at ${i.reorderLevel})`).join('\n'))
      : null,

    h('div.row', { style: { marginBottom: '2px' } }, segmented({
      options: [
        { value: 'stock', label: 'On hand' },
        { value: 'purchases', label: 'Purchases' },
        { value: 'suppliers', label: 'Suppliers' }
      ],
      value: state.tab, onChange: v => { state.tab = v; app.refresh(); }
    })),

    state.tab === 'stock' ? stockTab(ctx)
      : state.tab === 'purchases' ? purchasesTab(ctx)
      : suppliersTab(ctx)
  ];
}

/* ------------------------------------------------------------- on hand */

function stockTab(ctx) {
  const { store, app } = ctx;
  const currency = store.currency();
  const canManage = store.session.can('stock.manage');

  const rows = inv.listItems(store, {
    search: state.search || undefined,
    category: state.category || undefined,
    lowOnly: state.lowOnly
  }).map(item => {
    const qty = inv.onHand(store, item.id);
    return {
      id: item.id, code: item.code, name: item.name, category: item.category,
      unit: inv.unitShort(item.unit), qty, reorderLevel: item.reorderLevel,
      low: inv.isLow(store, item), cost: toMoney(item.lastCost),
      value: inv.stockValue(store, item.id)
    };
  });

  const filters = filterBar([
    h('span.filters__label', { text: 'Filter' }),
    h('input.input.input--sm', {
      type: 'search', value: state.search, placeholder: 'Search item or code…',
      oninput: e => { state.search = e.target.value; app.refresh(); }
    }),
    filterSelect('', state.category,
      [{ value: '', label: 'All categories' }].concat(STOCK_CATEGORIES.map(c => ({ value: c, label: c }))),
      v => { state.category = v; app.refresh(); }),
    h('button.btn.btn--sm' + (state.lowOnly ? '.btn--primary' : ''), {
      type: 'button', text: 'Low stock only',
      onclick: () => { state.lowOnly = !state.lowOnly; app.refresh(); }
    }),
    h('span.push', h('button.btn.btn--sm', { type: 'button', text: 'Export CSV',
      onclick: () => exportStock(store, rows) }))
  ]);

  const selected = state.selectedItemId ? store.db.get('stockItems', state.selectedItemId) : null;

  return h('div.split.split--rail', [
    h('div.stack', [
      filters,
      card({}, dataTable({
        currency,
        rows,
        selectedId: state.selectedItemId,
        onRowClick: row => { state.selectedItemId = row.id; app.refresh(); },
        rowClass: row => row.low ? 'is-warn' : null,
        columns: [
          { key: 'name', label: 'Item', render: row => h('div', [
              h('strong', { text: row.name }),
              row.code ? h('span.row__sub.text-xs.text-muted', { text: row.code }) : null
            ]) },
          { key: 'category', label: 'Category' },
          { key: 'qty', label: 'On hand', align: 'end',
            render: row => h('span.num', [
              h('span', { text: String(row.qty) + ' ' + row.unit }),
              row.low ? badge('LOW', 'warn') : null
            ]) },
          { key: 'reorderLevel', label: 'Reorder at', align: 'end',
            value: row => row.reorderLevel || '—' },
          { key: 'cost', label: 'Unit cost', format: 'money' },
          { key: 'value', label: 'Value', format: 'money' }
        ],
        totals: { value: rows.reduce((n, r) => n + r.value, 0) },
        totalsLabel: 'Stock value',
        empty: emptyState({
          title: 'Nothing tracked yet',
          body: 'Add the things this property buys — rice, oil, soap, linen — then record what arrives.',
          action: canManage ? h('button.btn.btn--primary', { type: 'button', text: 'Add the first item',
            onclick: () => itemForm(ctx) }) : null
        })
      }))
    ]),
    selected ? itemRail(ctx, selected) : null
  ]);
}

function itemRail(ctx, item) {
  const { store, app } = ctx;
  const currency = store.currency();
  const moves = inv.movesFor(store, item.id).slice(0, 25);
  const canManage = store.session.can('stock.manage');

  const qty = inv.onHand(store, item.id);
  const low = inv.isLow(store, item);

  return h('aside.rail', card({
    title: item.name,
    note: item.category + ' · per ' + inv.unitShort(item.unit),
    tools: [low ? badge('LOW', 'warn') : null]
  }, [
    railRows([
      { k: 'On hand', v: String(qty) + ' ' + inv.unitShort(item.unit) },
      { k: 'Reorder at', v: item.reorderLevel ? String(item.reorderLevel) : 'Not set' },
      { k: 'Last cost', v: formatMoney(item.lastCost, currency) },
      { k: 'Value', v: formatMoney(inv.stockValue(store, item.id), currency) },
      item.code ? { k: 'Code', v: item.code } : null
    ]),

    h('div', { style: { marginTop: '12px' } }, [
      h('div.field__label', { text: 'Recent movements' }),
      moves.length
        ? h('div.move-list', moves.map(m => {
            const r = inv.reasonOf(m.reason);
            return h('div.move', { 'data-dir': m.direction > 0 ? 'in' : m.direction < 0 ? 'out' : 'set' }, [
              h('span.move__qty.num', {
                text: (m.direction > 0 ? '+' : m.direction < 0 ? '−' : '=') + ' ' + m.qty
              }),
              h('span.move__what', [
                h('span', { text: r.label }),
                h('span.text-xs.text-muted', {
                  text: formatDate(m.date) + (m.department ? ' · ' + m.department : '') + (m.notes ? ' · ' + m.notes : '')
                })
              ]),
              h('span.move__value.num.text-xs.text-muted', { text: formatMoney(m.value, currency) })
            ]);
          }))
        : h('p.text-sm.text-muted', { text: 'Nothing has moved yet.' })
    ]),

    h('div', { style: { marginTop: '14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } }, [
      canManage
        ? h('button.btn.btn--sm', { type: 'button', text: 'Edit item', onclick: () => itemForm(ctx, item) }) : null,
      store.session.can('stock.move')
        ? h('button.btn.btn--sm', { type: 'button', text: 'Record movement',
            onclick: () => moveForm(ctx, { itemId: item.id }) }) : null,
      canManage
        ? h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Archive',
            onclick: async () => {
              if (!await confirm({ title: 'Archive this item?',
                message: 'It disappears from the list but its history is kept.' })) return;
              try { await inv.archiveItem(store, item.id); state.selectedItemId = ''; toastOk('Item archived'); app.refresh(); }
              catch (err) { fail(err); }
            } }) : null,
      h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Close',
        onclick: () => { state.selectedItemId = ''; app.refresh(); } })
    ])
  ]));
}

/* ----------------------------------------------------------- purchases */

function purchasesTab(ctx) {
  const { store, app } = ctx;
  const currency = store.currency();
  const report = inv.purchasesReport(store, state.from, state.to);

  return h('div.stack', [
    filterBar([
      rangePicker({
        preset: state.preset, from: state.from, to: state.to,
        onChange: v => { Object.assign(state, v); app.refresh(); }
      })
    ]),
    card({ title: 'Purchases', note: report.rows.length + ' bill(s)' }, dataTable({
      currency,
      rows: report.rows,
      onRowClick: row => purchaseDetail(ctx, row.id),
      columns: [
        { key: 'date', label: 'Date', format: 'date' },
        { key: 'code', label: 'Number' },
        { key: 'supplier', label: 'Supplier' },
        { key: 'billNo', label: 'Their bill no' },
        { key: 'total', label: 'Total', format: 'money' },
        { key: 'paid', label: 'Paid', format: 'money' },
        { key: 'due', label: 'Still owed', format: 'money',
          render: row => row.due > 0
            ? h('span.money-due.num', { text: formatMoney(row.due, currency) })
            : h('span.text-muted', { text: '—' }) }
      ],
      totals: { total: report.total, paid: report.paid, due: report.due },
      empty: emptyState({
        title: 'No purchases in this period',
        body: 'Record what arrives and the stock, the supplier account and the reports all follow from it.'
      })
    }))
  ]);
}

function purchaseDetail(ctx, purchaseId) {
  const { store, app } = ctx;
  const currency = store.currency();
  const purchase = store.db.get('purchases', purchaseId);
  if (!purchase) return;
  const lines = inv.purchaseLines(store, purchaseId);
  const due = toMoney(purchase.total) - toMoney(purchase.paid);

  const dialog = modal({
    title: 'Purchase ' + purchase.code,
    subtitle: inv.supplierName(store, purchase.supplierId) + ' · ' + formatDate(purchase.date),
    size: 'wide',
    body: h('div.stack', [
      purchase.status === 'cancelled'
        ? alert('warn', 'This purchase was cancelled',
            'Its stock was put back. ' + (purchase.cancelNote || '')) : null,
      dataTable({
        currency,
        rows: lines,
        columns: [
          { key: 'name', label: 'Item' },
          { key: 'qty', label: 'Quantity', align: 'end',
            value: row => String(row.qty) + ' ' + inv.unitShort(row.unit) },
          { key: 'cost', label: 'Unit cost', format: 'money' },
          { key: 'amount', label: 'Amount', format: 'money' }
        ]
      }),
      h('div.totals', [
        totalRow('Subtotal', formatMoney(purchase.gross, currency)),
        purchase.discount ? totalRow('Discount', '− ' + formatMoney(purchase.discount, currency)) : null,
        purchase.taxAmount ? totalRow('Tax ' + purchase.taxPercent + '%', formatMoney(purchase.taxAmount, currency)) : null,
        totalRow('Total', formatMoney(purchase.total, currency), 'is-total'),
        totalRow('Paid', formatMoney(purchase.paid, currency)),
        due > 0 ? totalRow('Still owed', formatMoney(due, currency), 'is-due') : null
      ]),
      purchase.notes ? h('p.text-sm.text-muted', { text: purchase.notes }) : null
    ]),
    footer: h('div.row', [
      purchase.status !== 'cancelled' && due > 0 && store.session.can('purchase.create')
        ? h('button.btn', { type: 'button', text: 'Record a payment',
            onclick: () => { dialog.close(); payForm(ctx, purchase); } }) : null,
      purchase.status !== 'cancelled' && store.session.can('purchase.cancel')
        ? h('button.btn.btn--ghost', { type: 'button', text: 'Cancel this purchase',
            onclick: async () => {
              if (!await confirm({
                title: 'Cancel purchase ' + purchase.code + '?',
                message: 'The stock it brought in will be taken back out. The bill is kept, marked cancelled.',
                tone: 'warn'
              })) return;
              try {
                await inv.cancelPurchase(store, purchaseId);
                dialog.close(); toastOk('Purchase cancelled'); app.refresh();
              } catch (err) { fail(err); }
            } }) : null,
      h('span.push', h('button.btn.btn--primary', { type: 'button', text: 'Close', onclick: () => dialog.close() }))
    ])
  });
}

function totalRow(label, value, cls) {
  return h('div.totals__row' + (cls ? '.' + cls : ''), [
    h('span.totals__label', { text: label }),
    h('span.totals__value.num', { text: value })
  ]);
}

/* ----------------------------------------------------------- suppliers */

function suppliersTab(ctx) {
  const { store, app } = ctx;
  const currency = store.currency();
  const report = inv.supplierBalancesReport(store);
  const all = inv.listSuppliers(store);

  const rows = all.map(s => {
    const b = inv.supplierBalance(store, s.id);
    return {
      id: s.id, name: s.name, phone: s.phone, city: s.city,
      purchases: b.purchases, billed: b.billed, paid: b.paid, outstanding: b.outstanding
    };
  });

  return h('div.stack', [
    card({ title: 'Suppliers', note: formatMoney(report.outstanding, currency) + ' outstanding' }, dataTable({
      currency,
      rows,
      onRowClick: row => supplierForm(ctx, store.db.get('suppliers', row.id)),
      columns: [
        { key: 'name', label: 'Supplier', render: row => h('div', [
            h('strong', { text: row.name }),
            row.city ? h('span.row__sub.text-xs.text-muted', { text: row.city }) : null
          ]) },
        { key: 'phone', label: 'Phone' },
        { key: 'purchases', label: 'Bills', align: 'end' },
        { key: 'billed', label: 'Billed', format: 'money' },
        { key: 'paid', label: 'Paid', format: 'money' },
        { key: 'outstanding', label: 'Outstanding', format: 'money',
          render: row => row.outstanding > 0
            ? h('span.money-due.num', { text: formatMoney(row.outstanding, currency) })
            : h('span.text-muted', { text: '—' }) }
      ],
      totals: { outstanding: report.outstanding },
      empty: emptyState({
        title: 'No suppliers yet',
        body: 'Add the shops and dealers this property buys from.',
        action: store.session.can('stock.manage')
          ? h('button.btn.btn--primary', { type: 'button', text: 'Add a supplier',
              onclick: () => supplierForm(ctx) }) : null
      })
    }))
  ]);
}

/* --------------------------------------------------------------- forms */

function itemForm(ctx, item) {
  const { store, app } = ctx;
  const form = h('div.form-grid.form-grid--2', [
    field({ label: 'Item name', name: 'name', required: true, value: item ? item.name : '',
      placeholder: 'Basmati rice', autofocus: true }),
    field({ label: 'Code', name: 'code', value: item ? item.code : '', placeholder: 'optional' }),
    field({ label: 'Urdu name', name: 'nameUr', urdu: true, value: item ? item.nameUr : '' }),
    field({ label: 'Category', name: 'category', type: 'select', value: item ? item.category : 'Kitchen',
      options: STOCK_CATEGORIES.map(c => ({ value: c, label: c })) }),
    field({ label: 'Unit of measure', name: 'unit', type: 'select', value: item ? item.unit : 'kg',
      options: STOCK_UNITS.map(u => ({ value: u.id, label: u.label + ' (' + u.short + ')' })) }),
    field({ label: 'Reorder level', name: 'reorderLevel', type: 'number', min: 0, step: 'any',
      value: item ? item.reorderLevel : 0,
      hint: 'Warn when stock falls to this. 0 means never warn.' }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', span: 'full', value: item ? item.notes : '' })
  ]);

  const dialog = modal({
    title: item ? 'Edit item' : 'Add stock item',
    body: form,
    footer: h('div.row', [
      h('span.push', h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() })),
      h('button.btn.btn--primary', { type: 'button', text: item ? 'Save' : 'Add item',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            await inv.saveItem(store, Object.assign({ id: item ? item.id : undefined }, v));
            dialog.close(); toastOk(item ? 'Item saved' : 'Item added'); app.refresh();
          } catch (err) {
            if (err.fields) applyErrors(form, err.fields); else fail(err);
          }
        }) })
    ])
  });
}

function supplierForm(ctx, supplier) {
  const { store, app } = ctx;
  const currency = store.currency();
  const balance = supplier ? inv.supplierBalance(store, supplier.id) : null;

  const form = h('div.form-grid.form-grid--2', [
    field({ label: 'Supplier name', name: 'name', required: true, value: supplier ? supplier.name : '',
      placeholder: 'Swat Traders', autofocus: true }),
    field({ label: 'Contact person', name: 'contactName', value: supplier ? supplier.contactName : '' }),
    field({ label: 'Phone', name: 'phone', value: supplier ? supplier.phone : '', inputmode: 'tel' }),
    field({ label: 'WhatsApp', name: 'whatsapp', value: supplier ? supplier.whatsapp : '', inputmode: 'tel' }),
    field({ label: 'City', name: 'city', value: supplier ? supplier.city : '' }),
    field({ label: 'NTN', name: 'ntn', value: supplier ? supplier.ntn : '' }),
    field({ label: 'Address', name: 'address', type: 'textarea', span: 'full', value: supplier ? supplier.address : '' }),
    supplier
      ? null
      : field({ label: 'Opening balance', name: 'openingBalance', type: 'number', min: 0, value: 0,
          hint: 'What this supplier is already owed. It cannot be changed later.' }),
    field({ label: 'Notes', name: 'notes', type: 'textarea', span: 'full', value: supplier ? supplier.notes : '' })
  ]);

  const dialog = modal({
    title: supplier ? supplier.name : 'Add supplier',
    subtitle: balance
      ? `${balance.purchases} bill(s) · ${formatMoney(balance.outstanding, currency)} outstanding`
      : null,
    body: form,
    footer: h('div.row', [
      supplier && store.session.can('stock.manage')
        ? h('button.btn.btn--ghost', { type: 'button', text: 'Archive',
            onclick: async () => {
              if (!await confirm({ title: 'Archive ' + supplier.name + '?',
                message: 'They disappear from the list. Their bills are kept.' })) return;
              try { await inv.archiveSupplier(store, supplier.id); dialog.close(); toastOk('Supplier archived'); app.refresh(); }
              catch (err) { fail(err); }
            } }) : null,
      h('span.push', h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() })),
      h('button.btn.btn--primary', { type: 'button', text: supplier ? 'Save' : 'Add supplier',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            await inv.saveSupplier(store, Object.assign({ id: supplier ? supplier.id : undefined }, v));
            dialog.close(); toastOk('Supplier saved'); app.refresh();
          } catch (err) {
            if (err.fields) applyErrors(form, err.fields); else fail(err);
          }
        }) })
    ])
  });
}

function moveForm(ctx, opts) {
  const { store, app } = ctx;
  const o = opts || {};
  const items = inv.listItems(store);
  if (!items.length) { fail(new Error('Add a stock item first.')); return; }

  let itemId = o.itemId || items[0].id;
  let reason = 'issue';
  const hint = h('div.field__hint');

  const refreshHint = () => {
    const item = store.db.get('stockItems', itemId);
    const r = inv.reasonOf(reason);
    const have = item ? inv.onHand(store, item.id) : 0;
    hint.textContent = r.direction === 0
      ? `A stock count sets the figure. There are ${have} ${item ? inv.unitShort(item.unit) : ''} recorded now.`
      : `${have} ${item ? inv.unitShort(item.unit) : ''} on hand.`;
  };

  const form = h('div.form-grid.form-grid--2', [
    field({ label: 'Item', name: 'itemId', type: 'select', value: itemId,
      options: items.map(i => ({ value: i.id, label: i.name + ' (' + inv.unitShort(i.unit) + ')' })),
      onChange: e => { itemId = e.target.value; refreshHint(); } }),
    field({ label: 'Reason', name: 'reason', type: 'select', value: reason,
      options: STOCK_REASONS.map(r => ({ value: r.id, label: r.label })),
      onChange: e => { reason = e.target.value; refreshHint(); } }),
    field({ label: 'Quantity', name: 'qty', type: 'number', min: 0, step: 'any', value: '', autofocus: true }),
    field({ label: 'Date', name: 'date', type: 'date', value: today() }),
    field({ label: 'Department', name: 'department', value: inv.settings(store).defaultDepartment,
      placeholder: 'Kitchen, Housekeeping…' }),
    field({ label: 'Notes', name: 'notes', value: '' }),
    h('div.field.span-full', hint)
  ]);
  refreshHint();

  const dialog = modal({
    title: 'Record a stock movement',
    body: form,
    footer: h('div.row', [
      h('span.push', h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() })),
      h('button.btn.btn--primary', { type: 'button', text: 'Record',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            await inv.recordMove(store, v);
            dialog.close(); toastOk('Movement recorded'); app.refresh();
          } catch (err) { fail(err); }
        }) })
    ])
  });
}

function purchaseForm(ctx) {
  const { store, app } = ctx;
  const currency = store.currency();
  const suppliers = inv.listSuppliers(store);
  const items = inv.listItems(store);

  if (!suppliers.length) { fail(new Error('Add a supplier first.')); return; }
  if (!items.length) { fail(new Error('Add a stock item first.')); return; }

  // Draft lines live here, not in the DOM, so the totals can never disagree
  // with what will be saved.
  const draft = { lines: [newLine()], discount: 0, taxPercent: 0, paid: 0 };
  function newLine() { return { itemId: items[0].id, qty: '', cost: '' }; }

  const linesBox = h('div.po-lines');
  const totalsBox = h('div.totals');

  const drawTotals = () => {
    const priced = inv.priceLines(draft.lines.filter(l => l.itemId && Number(l.qty) > 0), {
      discount: draft.discount, taxPercent: draft.taxPercent
    });
    mount(totalsBox, [
      totalRow('Subtotal', formatMoney(priced.gross, currency)),
      priced.discount ? totalRow('Discount', '− ' + formatMoney(priced.discount, currency)) : null,
      priced.taxAmount ? totalRow('Tax ' + priced.taxPercent + '%', formatMoney(priced.taxAmount, currency)) : null,
      totalRow('Total', formatMoney(priced.total, currency), 'is-total'),
      totalRow('Still owed after payment',
        formatMoney(Math.max(0, priced.total - (Number(draft.paid) || 0)), currency))
    ]);
  };

  const drawLines = () => {
    mount(linesBox, draft.lines.map((line, i) => {
      const item = store.db.get('stockItems', line.itemId);

      // The line's own amount is updated in place rather than by redrawing the
      // row: a redraw on every keystroke would take the focus out of the box
      // being typed into.
      const amount = h('span.po-line__amount.num');
      const showAmount = () => {
        amount.textContent = formatMoney(
          Math.round((Number(line.cost) || 0) * (Number(line.qty) || 0)), currency);
      };
      showAmount();
      const changed = () => { showAmount(); drawTotals(); };

      return h('div.po-line', [
        h('select.select', {
          onchange: e => { line.itemId = e.target.value; drawLines(); drawTotals(); }
        }, items.map(it => h('option', {
          value: it.id, selected: it.id === line.itemId,
          text: it.name + ' (' + inv.unitShort(it.unit) + ')'
        }))),
        h('input.input.po-line__qty', {
          type: 'number', min: 0, step: 'any', placeholder: 'Qty', value: line.qty,
          oninput: e => { line.qty = e.target.value; changed(); }
        }),
        h('input.input.po-line__cost', {
          type: 'number', min: 0, placeholder: 'Cost per ' + (item ? inv.unitShort(item.unit) : 'unit'),
          value: line.cost,
          oninput: e => { line.cost = e.target.value; changed(); }
        }),
        amount,
        h('button.icon-btn', {
          type: 'button', text: '×', title: 'Remove this line',
          disabled: draft.lines.length === 1,
          onclick: () => { draft.lines.splice(i, 1); drawLines(); drawTotals(); }
        })
      ]);
    }));
  };

  const head = h('div.form-grid.form-grid--3', [
    field({ label: 'Supplier', name: 'supplierId', type: 'select',
      options: suppliers.map(s => ({ value: s.id, label: s.name })) }),
    field({ label: 'Date', name: 'date', type: 'date', value: today() }),
    field({ label: 'Their bill no', name: 'billNo', placeholder: 'optional' })
  ]);

  const money = h('div.form-grid.form-grid--3', [
    field({ label: 'Discount', name: 'discount', type: 'number', min: 0, value: 0,
      onInput: e => { draft.discount = Number(e.target.value) || 0; drawTotals(); } }),
    field({ label: 'Tax %', name: 'taxPercent', type: 'number', min: 0, max: 100, step: '0.5', value: 0,
      onInput: e => { draft.taxPercent = Number(e.target.value) || 0; drawTotals(); } }),
    field({ label: 'Paid now', name: 'paid', type: 'number', min: 0, value: 0,
      onInput: e => { draft.paid = Number(e.target.value) || 0; drawTotals(); } })
  ]);

  drawLines();
  drawTotals();

  const dialog = modal({
    title: 'Record a purchase',
    subtitle: 'Stock goes up and the supplier account follows from this one form.',
    size: 'wide',
    body: h('div.stack', [
      head,
      h('div.field', [
        h('div.field__label', { text: 'Items delivered' }),
        linesBox,
        h('button.btn.btn--sm', { type: 'button', text: '+ Add another item',
          onclick: () => { draft.lines.push(newLine()); drawLines(); drawTotals(); } })
      ]),
      money,
      totalsBox,
      field({ label: 'Notes', name: 'notes', type: 'textarea', span: 'full' })
    ]),
    footer: h('div.row', [
      h('span.push', h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() })),
      h('button.btn.btn--primary', { type: 'button', text: 'Record purchase',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(dialog.el);
          try {
            const saved = await inv.recordPurchase(store, {
              supplierId: v.supplierId, date: v.date, billNo: v.billNo, notes: v.notes,
              discount: draft.discount, taxPercent: draft.taxPercent, paid: draft.paid,
              lines: draft.lines
            });
            dialog.close();
            toastOk('Purchase ' + saved.code + ' recorded', 'Stock updated.');
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ])
  });
}

function payForm(ctx, purchase) {
  const { store, app } = ctx;
  const currency = store.currency();
  const due = toMoney(purchase.total) - toMoney(purchase.paid);

  const form = h('div.stack', [
    h('p.text-sm.text-muted', {
      text: `${inv.supplierName(store, purchase.supplierId)} · ${formatMoney(due, currency)} outstanding on ${purchase.code}.`
    }),
    field({ label: 'Amount paid', name: 'amount', type: 'number', min: 1, max: due, value: due, autofocus: true })
  ]);

  const dialog = modal({
    title: 'Pay a supplier bill',
    body: form,
    footer: h('div.row', [
      h('span.push', h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() })),
      h('button.btn.btn--primary', { type: 'button', text: 'Record payment',
        onclick: e => busy(e.currentTarget, async () => {
          try {
            await inv.paySupplier(store, purchase.id, formValues(form).amount);
            dialog.close(); toastOk('Payment recorded'); app.refresh();
          } catch (err) { fail(err); }
        }) })
    ])
  });
}

/* ----------------------------------------------------------------- csv */

function exportStock(store, rows) {
  const csv = toCsv(rows.map(r => ({
    Code: r.code, Item: r.name, Category: r.category,
    'On hand': r.qty, Unit: r.unit, 'Reorder at': r.reorderLevel,
    'Unit cost': r.cost, Value: r.value
  })));
  downloadFile('stock-on-hand-' + today() + '.csv', csv, 'text/csv');
  toastOk('Stock exported');
}
