/**
 * Reusable UI pieces. Every screen is assembled from these, so spacing, type
 * and state styling stay identical across the product.
 */

import { h } from './dom.js';
import { formatMoney, toMoney } from '../core/money.js';
import { formatDate, formatDateTime, presetRange, today } from '../core/dates.js';
import { UNIT_STATUS, HK_STATUS, RESERVATION_STATUS } from '../core/schema.js';

/* ------------------------------------------------------------------ atoms */

export function kpi(opts) {
  const node = h(opts.onClick ? 'button.kpi.is-clickable' : 'div.kpi', {
    class: opts.tone ? 'kpi--' + opts.tone : null,
    type: opts.onClick ? 'button' : null,
    onclick: opts.onClick || null,
    title: opts.title || null
  }, [
    h('div.kpi__label', { text: opts.label }),
    h('div.kpi__value', { text: opts.value }),
    opts.sub ? h('div.kpi__sub', { text: opts.sub }) : h('div.kpi__sub', { html: '&nbsp;' })
  ]);
  return node;
}

export function badge(label, tone) {
  return h('span.badge.badge--' + (tone || 'muted'), { text: label });
}

const UNIT_TONE = { available: 'ok', reserved: 'accent', occupied: 'river', cleaning: 'warn', maintenance: 'muted', blocked: 'muted' };
const HK_TONE   = { clean: 'ok', dirty: 'warn', cleaning: 'river', inspected: 'ok' };
const RES_TONE  = { reserved: 'accent', checked_in: 'river', checked_out: 'muted', cancelled: 'muted', no_show: 'due' };

export function unitBadge(status) {
  const s = UNIT_STATUS.find(x => x.id === status);
  return badge(s ? s.label : status, UNIT_TONE[status] || 'muted');
}
export function hkBadge(status) {
  const s = HK_STATUS.find(x => x.id === status);
  return badge(s ? s.label : status, HK_TONE[status] || 'muted');
}
export function reservationBadge(status) {
  const s = RESERVATION_STATUS.find(x => x.id === status);
  return badge(s ? s.label : status, RES_TONE[status] || 'muted');
}

export function unitStatusColor(status) {
  const map = {
    available: 'var(--ok)', reserved: 'var(--accent)', occupied: 'var(--river)',
    cleaning: 'var(--warn)', maintenance: 'var(--muted)', blocked: 'var(--muted-soft)'
  };
  return map[status] || 'var(--muted)';
}

export function moneyText(amount, currency, tone) {
  const cls = tone === 'due' && toMoney(amount) > 0 ? '.money-due'
            : tone === 'ok' ? '.money-ok' : '';
  return h('span.mono' + cls, { text: formatMoney(amount, currency) });
}

export function card(opts, children) {
  return h('section.card', { class: opts.class }, [
    (opts.title || opts.tools) ? h('div.card__head', [
      opts.title ? h('h2.card__title', { text: opts.title }) : null,
      opts.titleUr ? h('span.card__ur', { text: opts.titleUr }) : null,
      opts.note ? h('span.card__note', { text: opts.note }) : null,
      opts.tools ? h('div.card__tools', opts.tools) : null
    ]) : null,
    h('div.card__body' + (opts.flush ? '.card__body--flush' : ''), children),
    opts.foot ? h('div.card__foot', opts.foot) : null
  ]);
}

export function emptyState(opts) {
  return h('div.empty', [
    h('div.empty__title', { text: opts.title || 'Nothing here yet' }),
    opts.body ? h('div.empty__body', { text: opts.body }) : null,
    opts.action ? h('div.empty__action', opts.action) : null
  ]);
}

export function alert(tone, title, body, extra) {
  return h('div.alert.alert--' + tone, [
    h('div', { style: { minWidth: 0 } }, [
      title ? h('div.alert__title', { text: title }) : null,
      body ? h('div', { text: body, style: { marginTop: title ? '3px' : 0, whiteSpace: 'pre-line' } }) : null,
      extra || null
    ])
  ]);
}

export function spinnerRows(count, cols) {
  return Array.from({ length: count || 4 }, () =>
    h('tr', Array.from({ length: cols || 5 }, () =>
      h('td', h('div.skeleton', { style: { height: '12px', width: (40 + Math.random() * 50) + '%' } }))))); 
}

/* ------------------------------------------------------------------ forms */

export function field(opts) {
  const id = opts.name ? 'f_' + opts.name : undefined;
  let control;

  if (opts.type === 'textarea') {
    control = h('textarea.textarea', {
      id, name: opts.name, placeholder: opts.placeholder || '', rows: opts.rows || 3,
      value: opts.value !== undefined && opts.value !== null ? String(opts.value) : '',
      disabled: opts.disabled, class: opts.mono ? 'input--mono' : (opts.urdu ? 'input--ur' : null),
      oninput: opts.onInput || null
    });
  } else if (opts.type === 'select') {
    control = h('select.select', {
      id, name: opts.name, disabled: opts.disabled, onchange: opts.onChange || null
    }, (opts.options || []).map(o => {
      const value = typeof o === 'string' ? o : o.value;
      const label = typeof o === 'string' ? o : o.label;
      return h('option', { value, selected: String(value) === String(opts.value === undefined ? '' : opts.value), text: label });
    }));
  } else {
    control = h('input.input', {
      id, name: opts.name, type: opts.type || 'text',
      placeholder: opts.placeholder || '',
      value: opts.value !== undefined && opts.value !== null ? String(opts.value) : '',
      disabled: opts.disabled, readOnly: opts.readOnly,
      min: opts.min, max: opts.max, step: opts.step,
      inputmode: opts.inputmode || (opts.type === 'number' ? 'numeric' : null),
      autocomplete: opts.autocomplete || 'off',
      class: opts.mono ? 'input--mono' : (opts.urdu ? 'input--ur' : null),
      oninput: opts.onInput || null, onchange: opts.onChange || null,
      onblur: opts.onBlur || null, onkeydown: opts.onKeyDown || null,
      autofocus: opts.autofocus
    });
  }

  return h('div.field', { class: opts.span === 2 ? 'span-2' : opts.span === 'full' ? 'span-full' : null }, [
    opts.label ? h('label.field__label', { for: id }, [
      opts.label,
      opts.required ? h('span.req', { text: '*' }) : null
    ]) : null,
    control,
    opts.hint ? h('div.field__hint', { text: opts.hint }) : null
  ]);
}

export function checkbox(opts) {
  return h('label.check', [
    h('input', { type: 'checkbox', name: opts.name, checked: !!opts.value, disabled: opts.disabled, onchange: opts.onChange || null }),
    h('span', { text: opts.label })
  ]);
}

/** Single-choice chips — payment methods, booking sources, view switches. */
export function chipGroup(opts) {
  return h('div.chips', (opts.options || []).map(o => {
    const value = typeof o === 'string' ? o : o.value;
    const label = typeof o === 'string' ? o : o.label;
    return h('button.chip', {
      type: 'button',
      class: String(value) === String(opts.value) ? 'is-on' : null,
      text: label,
      onclick: () => opts.onChange && opts.onChange(value)
    });
  }));
}

export function segmented(opts) {
  return h('div.btn-group', (opts.options || []).map(o => {
    const value = typeof o === 'string' ? o : o.value;
    const label = typeof o === 'string' ? o : o.label;
    return h('button', {
      type: 'button',
      class: String(value) === String(opts.value) ? 'is-active' : null,
      text: label,
      onclick: () => opts.onChange && opts.onChange(value)
    });
  }));
}

export function button(label, opts) {
  const o = opts || {};
  return h('button.btn' + (o.variant ? '.btn--' + o.variant : '') + (o.size ? '.btn--' + o.size : ''), {
    type: 'button', onclick: o.onClick || null, disabled: o.disabled,
    title: o.title || null, class: o.class
  }, [label, o.key ? h('span.btn__key', { text: o.key }) : null]);
}

/* ----------------------------------------------------------------- tables */

/**
 * A data table.
 *
 * columns: [{ key, label, align, format, width, render(row) }]
 * `format: 'money' | 'date' | 'datetime'` handles the common cases so screens
 * do not repeat formatting.
 */
export function dataTable(opts) {
  const columns = opts.columns || [];
  const rows = opts.rows || [];
  const currency = opts.currency || 'Rs';

  const cellContent = (col, row) => {
    if (col.render) return col.render(row);
    const raw = typeof col.value === 'function' ? col.value(row) : row[col.key];
    if (col.format === 'money') return formatMoney(raw, currency);
    if (col.format === 'date') return formatDate(raw);
    if (col.format === 'datetime') return formatDateTime(raw);
    if (col.format === 'percent') return String(raw) + '%';
    return raw === null || raw === undefined || raw === '' ? '—' : String(raw);
  };

  const isNum = col => col.align === 'end' || col.format === 'money' || col.format === 'percent';
  // A date broken over three lines is unreadable, and it happens as soon as a
  // wide table is squeezed — which the 16-column register always is.
  const isAtomic = col => col.format === 'date' || col.format === 'datetime' || isNum(col);

  const body = rows.length
    ? rows.map((row, i) => h('tr', {
        class: [opts.rowClass ? opts.rowClass(row) : '', opts.selectedId && row.id === opts.selectedId ? 'is-selected' : ''].filter(Boolean).join(' ') || null,
        style: opts.onRowClick ? { cursor: 'pointer' } : null,
        onclick: opts.onRowClick ? (e) => { if (!e.target.closest('button,a,input,select')) opts.onRowClick(row, i); } : null
      }, columns.map(col => h('td', {
        class: [isNum(col) ? 'num' : '', isAtomic(col) ? 'nowrap' : '', col.class || ''].filter(Boolean).join(' ') || null,
        style: col.width ? { width: col.width } : null
      }, cellContent(col, row)))))
    : [h('tr', h('td', { colspan: columns.length, style: { padding: 0, border: 0 } },
        opts.empty || emptyState({ title: 'No records', body: opts.emptyBody })))];

  const footRow = opts.totals ? h('tfoot', h('tr', columns.map((col, i) => {
    if (i === 0) return h('td', opts.totalsLabel || 'Total');
    const v = opts.totals[col.key];
    if (v === undefined) return h('td');
    return h('td.num', col.format === 'money' ? formatMoney(v, currency) : String(v));
  }))) : null;

  return h('div.table-wrap', h('table.table' + (opts.compact ? '.table--compact' : ''), [
    h('thead', h('tr', columns.map(col => h('th', {
      class: isNum(col) ? 'num' : null,
      style: col.width ? { width: col.width } : null,
      text: col.label
    })))),
    h('tbody', body),
    footRow
  ]));
}

/* ---------------------------------------------------------------- filters */

export function filterBar(children) {
  return h('div.filters', children);
}

export function filterSelect(label, value, options, onChange) {
  return h('label.row.row--tight', { style: { gap: '6px' } }, [
    label ? h('span.filters__label', { text: label }) : null,
    h('select.select', { onchange: e => onChange(e.target.value) },
      options.map(o => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return h('option', { value: v, selected: String(v) === String(value), text: l });
      }))
  ]);
}

/** Preset ranges plus a custom from/to pair — the requirement 26 filter set. */
export function rangePicker(opts) {
  const presets = [
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: 'week', label: 'This week' },
    { value: 'month', label: 'This month' },
    { value: 'last30', label: 'Last 30 days' },
    { value: 'custom', label: 'Custom' }
  ];
  const change = (preset, from, to) => {
    if (preset !== 'custom') {
      const r = presetRange(preset);
      opts.onChange({ preset, from: r.from, to: r.to });
    } else {
      opts.onChange({ preset: 'custom', from: from || opts.from || today(), to: to || opts.to || today() });
    }
  };

  return h('div.row.row--tight', [
    segmented({ options: presets, value: opts.preset || 'today', onChange: p => change(p) }),
    opts.preset === 'custom' ? h('div.row.row--tight', [
      h('input.input', { type: 'date', value: opts.from, style: { width: 'auto' }, onchange: e => change('custom', e.target.value, opts.to) }),
      h('span.text-muted.text-sm', { text: 'to' }),
      h('input.input', { type: 'date', value: opts.to, style: { width: 'auto' }, onchange: e => change('custom', opts.from, e.target.value) })
    ]) : null
  ]);
}

/* ------------------------------------------------------------- misc bits */

export function statusStrip(items, onSelect) {
  return h('div', [
    h('div.statusbar', items.filter(i => i.count > 0).map(i =>
      h('div.statusbar__seg', { style: { flex: String(i.count), background: i.color }, title: `${i.label}: ${i.count}` }))),
    h('div.status-list', items.map(i =>
      h('button', { type: 'button', onclick: onSelect ? () => onSelect(i) : null }, [
        h('span.dot', { style: { background: i.color } }),
        h('span', { text: i.label, style: { flex: '1' } }),
        h('span.num', { text: String(i.count) })
      ])))
  ]);
}

export function totalsRail(rows, currency) {
  return h('div.totals', rows.filter(Boolean).map(r =>
    h('div.totals__row' + (r.rule ? '.totals__row--rule' : '') + (r.kind ? '.totals__row--' + r.kind : ''), [
      h('span.totals__label', { text: r.label }),
      h('span.totals__value', { text: r.raw !== undefined ? r.raw : formatMoney(r.value, currency) })
    ])));
}

export function railRows(rows) {
  return h('div.rail__rows', rows.filter(Boolean).map(r =>
    h('div.rail__row', [
      h('span.rail__k', { text: r.k }),
      r.node ? h('span.rail__v', r.node) : h('span.rail__v', { text: r.v })
    ])));
}

export function pageHead(title, titleUr, actions) {
  return h('div.page__head', [
    h('div', [
      h('h1.page__title', { text: title }),
      titleUr ? h('div.page__title-ur', { text: titleUr }) : null
    ]),
    actions ? h('div.page__actions', actions) : null
  ]);
}

export function conflictList(conflicts) {
  if (!conflicts || !conflicts.length) return null;
  return h('ul', { style: { margin: '6px 0 0', paddingInlineStart: '18px', fontSize: '12.5px' } },
    conflicts.map(c => h('li', { text: c.text || `${c.code} · ${c.guestName}` })));
}
