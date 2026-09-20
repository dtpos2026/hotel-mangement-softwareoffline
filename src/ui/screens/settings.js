/**
 * Settings (requirement 32): property profile, receipt and printer geometry,
 * currency and tax, booking rules, users and roles, backup and restore.
 */

import { h, mount, qs, formValues, applyErrors, busy, readImage } from '../dom.js';
import { card, dataTable, emptyState, pageHead, field, checkbox, segmented, badge, alert, kpi, railRows } from '../components.js';
import { modal, confirm, promptText, toast, ok as toastOk, info, warn, fail } from '../feedback.js';
import { PROPERTY_TYPES } from '../../core/schema.js';
import { ROLES, roleLabel, hashPassword, newSalt, permissionsFor, PERMISSIONS, checkPassword } from '../../core/auth.js';
import { buildBackup, backupFilename, validateBackup, restoreBackup, readAutoBackups, saveAutoBackup, downloadFile, readFileAsText } from '../../core/backup.js';
import { formatDateTime, nowIso } from '../../core/dates.js';
import { formatMoney } from '../../core/money.js';
import { newId } from '../../core/ids.js';
import { printTestPage, printSample } from '../print-actions.js';
import { printerSettings, contentWidthMm } from '../../print/printer.js';
import { templateList, sampleReceipt } from '../../print/receipt80.js';
import * as host from '../../core/host.js';
import { activationCard } from './activation.js';
import { whatsappPanel } from '../whatsapp.js';
import * as rest from '../../domain/restaurant.js';
import * as invApi from '../../domain/inventory.js';
import { CATEGORY_COLOURS } from '../../core/schema.js';

const TABS = [
  { id: 'property', label: 'Property' },
  { id: 'printing', label: 'Receipt & printer' },
  { id: 'booking', label: 'Booking rules' },
  { id: 'users', label: 'Users & roles' },
  { id: 'backup', label: 'Backup & restore' },
  { id: 'restaurant', label: 'Restaurant' },
  { id: 'inventory', label: 'Stock' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'licence', label: 'Licence' },
  { id: 'about', label: 'About & data' }
];

const state = { tab: 'property' };

export function render(ctx) {
  const { app, params } = ctx;
  if (params.tab) { state.tab = params.tab; params.tab = null; }

  const body = {
    property: propertyTab, printing: printingTab, booking: bookingTab,
    users: usersTab, backup: backupTab, restaurant: restaurantTab, inventory: inventoryTab,
    whatsapp: whatsappTab,
    licence: licenceTab, about: aboutTab
  }[state.tab] || propertyTab;

  return [
    pageHead('Settings', 'ترتیبات', []),
    h('div.filters', h('div.row.row--tight', TABS.map(t => h('button.chip', {
      type: 'button', class: t.id === state.tab ? 'is-on' : null, text: t.label,
      onclick: () => { state.tab = t.id; app.refresh(); }
    })))),
    body(ctx)
  ];
}

/* --------------------------------------------------------------- property */

function propertyTab(ctx) {
  const { store, app } = ctx;
  const p = store.property;
  const canEdit = store.session.can('settings.manage');
  const logoBox = h('div');
  let logo = p.logo || '';

  const renderLogo = () => mount(logoBox, h('div.row', [
    h('div', {
      style: {
        width: '72px', height: '72px', border: '1px solid var(--line)', borderRadius: 'var(--r)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        background: 'var(--surface-sunk)', flex: '0 0 72px'
      }
    }, logo ? h('img', { src: logo, style: { width: '100%', height: '100%', objectFit: 'contain' } })
            : h('span.text-xs.text-muted', { text: 'No logo' })),
    h('div.stack.stack--sm', [
      h('label.btn.btn--sm', { style: { cursor: 'pointer' } }, [
        'Choose image',
        h('input', { type: 'file', accept: 'image/*', style: { display: 'none' },
          onchange: async e => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try { logo = await readImage(file, 320); renderLogo(); info('Logo loaded', 'Save the profile to keep it.'); }
            catch (err) { fail(err); }
          } })
      ]),
      logo ? h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Remove',
        onclick: () => { logo = ''; renderLogo(); } }) : null,
      h('div.text-xs.text-muted', { text: 'Used on receipts, invoices and reports. Resized to 320px on save.' })
    ])
  ]));
  renderLogo();

  const form = h('div.stack', [
    card({ title: 'Property profile' }, h('div.stack', [
      h('div.field', [h('div.field__label', { text: 'Logo' }), logoBox]),
      h('div.form-grid.form-grid--3', [
        field({ label: 'Property name', name: 'name', required: true, value: p.name, span: 2, disabled: !canEdit }),
        field({ label: 'Name in Urdu', name: 'nameUr', value: p.nameUr, urdu: true, disabled: !canEdit }),
        field({ label: 'Property type', name: 'type', type: 'select', value: p.type, disabled: !canEdit,
          options: PROPERTY_TYPES.map(t => ({ value: t.id, label: t.label })),
          hint: 'Decides whether the app says Room, Cottage, Apartment…' }),
        field({ label: 'Phone', name: 'phone', mono: true, value: p.phone, placeholder: '0300-1234567', disabled: !canEdit }),
        field({ label: 'WhatsApp', name: 'whatsapp', mono: true, value: p.whatsapp, disabled: !canEdit }),
        field({ label: 'Email', name: 'email', type: 'email', value: p.email, disabled: !canEdit }),
        field({ label: 'Address', name: 'address', value: p.address, span: 2, disabled: !canEdit }),
        field({ label: 'City', name: 'city', value: p.city, disabled: !canEdit })
      ])
    ])),

    card({ title: 'Times, currency and tax' }, h('div.form-grid.form-grid--3', [
      field({ label: 'Check-in time', name: 'checkInTime', type: 'time', value: p.checkInTime, disabled: !canEdit }),
      field({ label: 'Check-out time', name: 'checkOutTime', type: 'time', value: p.checkOutTime, disabled: !canEdit }),
      field({ label: 'Currency symbol', name: 'currency', value: p.currency, placeholder: 'Rs', disabled: !canEdit }),
      h('div.field', { style: { justifyContent: 'flex-end' } },
        checkbox({ label: 'Charge tax on bills', name: 'taxEnabled', value: p.taxEnabled, disabled: !canEdit })),
      field({ label: 'Tax name', name: 'taxName', value: p.taxName, placeholder: 'GST', disabled: !canEdit }),
      field({ label: 'Tax percent', name: 'taxPercent', type: 'number', min: 0, max: 100, step: '0.01', value: p.taxPercent, disabled: !canEdit })
    ])),

    card({ title: 'Document footers' }, h('div.form-grid.form-grid--2', [
      field({ label: 'Invoice footer (A4)', name: 'invoiceFooter', type: 'textarea', rows: 2, value: p.invoiceFooter, disabled: !canEdit }),
      field({ label: 'Receipt footer (80mm)', name: 'receiptFooter', type: 'textarea', rows: 2, value: p.receiptFooter, disabled: !canEdit })
    ]))
  ]);

  return h('div.stack', [
    !canEdit ? alert('info', 'Read-only', 'Your role can see these settings but not change them.') : null,
    form,
    canEdit ? h('div.row', [
      h('button.btn.btn--primary.btn--lg', { type: 'button', text: 'Save property profile',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            await store.updateProperty(Object.assign({}, v, { logo, taxPercent: Number(v.taxPercent) || 0 }));
            toastOk('Property profile saved', v.name);
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ]) : null
  ]);
}

/* --------------------------------------------------------------- printing */

function printingTab(ctx) {
  const { store, app } = ctx;
  const canEdit = store.session.can('settings.manage');
  const s = printerSettings(store);
  const preview = h('div');

  const drawGeometry = (values) => {
    const width = Number(values.widthMm) || s.widthMm;
    const left = Number(values.marginLeftMm) || 0;
    const right = Number(values.marginRightMm) || 0;
    const area = Math.max(0, width - left - right);
    const balanced = Math.abs(left - right) <= 0.5;
    mount(preview, h('div.stack.stack--sm', [
      h('div', {
        style: { background: 'var(--surface-sunk)', border: '1px solid var(--line)', borderRadius: 'var(--r)', padding: '12px' }
      }, [
        h('div', { style: { display: 'flex', width: '100%', height: '46px', border: '1px solid var(--line-strong)', borderRadius: '3px', overflow: 'hidden', background: '#fff' } }, [
          h('div', { style: { flex: String(left || 0.01), background: 'repeating-linear-gradient(45deg,var(--line-soft),var(--line-soft) 4px,transparent 4px,transparent 8px)' } }),
          h('div', { style: { flex: String(area), background: 'var(--accent-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '600', color: 'var(--accent)' },
            text: area.toFixed(1) + 'mm print area' }),
          h('div', { style: { flex: String(right || 0.01), background: 'repeating-linear-gradient(45deg,var(--line-soft),var(--line-soft) 4px,transparent 4px,transparent 8px)' } })
        ]),
        h('div.row', { style: { marginTop: '6px', justifyContent: 'space-between' } }, [
          h('span.text-xs.text-muted', { text: `${left}mm left` }),
          h('span.text-xs.text-muted', { text: `${width}mm paper` }),
          h('span.text-xs.text-muted', { text: `${right}mm right` })
        ])
      ]),
      balanced
        ? h('div.text-xs', { style: { color: 'var(--deodar)' }, text: '✓ Left and right margins are equal, so the text sits centred on the roll.' })
        : h('div.text-xs', { style: { color: 'var(--warn)' }, text: '⚠ Left and right margins differ; the text will sit off-centre on the paper.' }),
      area > 76
        ? h('div.text-xs', { style: { color: 'var(--warn)' }, text: '⚠ Most 80mm heads only image about 72mm. This may clip at the edges — run a test print.' })
        : null
    ]));
  };

  const form = h('div.stack', [
    card({ title: '80mm thermal receipt', note: 'paper geometry' }, h('div.stack', [
      h('div.form-grid.form-grid--4', [
        field({ label: 'Paper width (mm)', name: 'widthMm', type: 'number', min: 40, max: 120, value: s.widthMm,
          hint: '80 or 58', disabled: !canEdit, onInput: onChange }),
        field({ label: 'Left margin (mm)', name: 'marginLeftMm', type: 'number', min: 0, max: 20, step: '0.5', value: s.marginLeftMm, disabled: !canEdit, onInput: onChange }),
        field({ label: 'Right margin (mm)', name: 'marginRightMm', type: 'number', min: 0, max: 20, step: '0.5', value: s.marginRightMm, disabled: !canEdit, onInput: onChange }),
        h('div.field', { style: { justifyContent: 'flex-end' } },
          h('button.btn.btn--sm', { type: 'button', text: 'Match left & right', disabled: !canEdit,
            onclick: () => {
              const left = qs('[name="marginLeftMm"]', form);
              const right = qs('[name="marginRightMm"]', form);
              if (left && right) { right.value = left.value; onChange(); }
            } })),
        field({ label: 'Top margin (mm)', name: 'marginTopMm', type: 'number', min: 0, max: 30, step: '0.5', value: s.marginTopMm, disabled: !canEdit, onInput: onChange }),
        field({ label: 'Bottom margin (mm)', name: 'marginBottomMm', type: 'number', min: 0, max: 40, step: '0.5', value: s.marginBottomMm,
          hint: 'feed before the cut', disabled: !canEdit, onInput: onChange }),
        field({ label: 'Font size (pt)', name: 'fontSizePt', type: 'number', min: 7, max: 16, step: '0.5', value: s.fontSizePt, disabled: !canEdit }),
        field({ label: 'Compact font size (pt)', name: 'compactFontSizePt', type: 'number', min: 6, max: 14, step: '0.5', value: s.compactFontSizePt, disabled: !canEdit })
      ]),
      preview
    ])),

    card({ title: 'Logo, mode and copies' }, h('div.stack', [
      h('div.form-grid.form-grid--3', [
        field({ label: 'Logo height (px)', name: 'logoSizePx', type: 'number', min: 32, max: 240, value: s.logoSizePx, disabled: !canEdit }),
        field({ label: 'Copies per print', name: 'copies', type: 'number', min: 1, max: 5, value: s.copies,
          hint: 'guest copy + desk copy', disabled: !canEdit }),
        field({ label: 'A4 margin (mm)', name: 'a4MarginMm', type: 'number', min: 5, max: 30, value: s.a4MarginMm, disabled: !canEdit })
      ]),
      h('div.form-grid.form-grid--2', [
        h('div.field', [
          h('div.field__label', { text: 'Default receipt mode' }),
          h('div', { id: 'modeBox' })
        ]),
        h('div.field', { style: { justifyContent: 'center' } },
          checkbox({ label: 'Print the logo on receipts', name: 'showLogo', value: s.showLogo, disabled: !canEdit }))
      ]),
      h('div.field', [
        h('label.field__label', { text: 'Receipt printer' }),
        h('div', { id: 'printerBox' }),
        h('div.field__hint', { id: 'printerHint' })
      ]),
      host.isDesktop ? checkbox({ label: 'Print receipts without showing the print dialog', name: 'silentPrint',
        value: s.silentPrint, disabled: !canEdit }) : null
    ])),

    card({ title: 'Receipt design', note: 'logo, name and address' }, h('div.stack', [
      h('div.field__hint', { text: 'The figures and the columns are the same in every design — only the letterhead changes. The logo and address come from Settings › Property.' }),
      h('div', { id: 'designBox' }),
      h('div', { id: 'designPreview' })
    ])),

    card({ title: 'Test and preview' }, h('div.stack', [
      h('div.row', [
        h('button.btn.btn--primary', { type: 'button', text: 'Test print', onclick: () => printTestPage(store) }),
        h('span.text-sm.text-muted', { text: 'Prints an alignment ruler and the geometry currently saved.' })
      ]),
      alert('info', 'Getting a clean 80mm print in the browser', [
        '1. Save these settings first — the test page uses the saved values.',
        '2. In the print dialog, set Margins to None and turn Headers and footers off.',
        '3. Set Scale to 100% (not "Fit to page").',
        '4. If the ruler is clipped at either edge, increase the left and right margins by 1mm and test again.'
      ].join('\n'))
    ]))
  ]);

  function onChange() {
    drawGeometry(formValues(form));
  }

  // The desktop build can enumerate real printers; the browser cannot, so it
  // falls back to a note for staff and the system print dialog.
  let printerName = s.printerName;
  setTimeout(async () => {
    const box = qs('#printerBox', form);
    const hint = qs('#printerHint', form);
    if (!box) return;
    if (!host.isDesktop) {
      mount(box, h('input.input', {
        name: 'printerName', value: printerName, disabled: !canEdit,
        placeholder: 'XPrinter XP-80C at reception',
        oninput: e => { printerName = e.target.value; }
      }));
      hint.textContent = 'A browser cannot choose a printer for you, so this is only a note for staff — the printer is picked in the system print dialog. The installed desktop version prints straight to the printer you choose here.';
      return;
    }
    mount(box, h('div.text-sm.text-muted', { text: 'Looking for printers\u2026' }));
    const printers = await host.listPrinters();
    if (!printers.length) {
      mount(box, h('div.text-sm', { text: 'No printers found on this computer.' }));
      hint.textContent = 'Install the printer in Windows first, then reopen this screen.';
      return;
    }
    if (!printerName || !printers.some(p => p.name === printerName)) {
      const fallback = printers.find(p => p.isDefault) || printers[0];
      printerName = fallback.name;
    }
    mount(box, h('select.select', {
      name: 'printerName', disabled: !canEdit,
      onchange: e => { printerName = e.target.value; }
    }, printers.map(p => h('option', {
      value: p.name,
      selected: p.name === printerName,
      text: p.displayName + (p.isDefault ? '  (Windows default)' : '')
    }))));
    hint.textContent = `${printers.length} printer(s) found. Receipts print straight to this one.`;
  }, 0);

  // Receipt design: a card per template, and a real 80mm receipt rendered
  // beside them so the choice is made by looking rather than by guessing.
  let template = templateList().some(t => t.key === s.template) ? s.template : 'classic';
  setTimeout(() => {
    const box = qs('#designBox', form);
    const preview = qs('#designPreview', form);
    if (!box || !preview) return;

    const drawPreview = () => {
      const paper = printerSettings(store).widthMm;
      mount(preview, h('div.receipt-preview', [
        h('div.receipt-preview__head', [
          h('span.text-xs.text-muted', { text: paper + 'mm paper · ' + (mode === 'compact' ? 'compact' : 'normal') + ' mode · sample figures' }),
          h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Print this sample',
            onclick: () => printSample(store, { template, mode }) })
        ]),
        h('div.receipt-preview__paper', [
          h('iframe.receipt-preview__frame', {
            title: 'Receipt preview',
            srcdoc: sampleReceipt(store, { template, mode })
          })
        ])
      ]));
    };

    const drawPicker = () => {
      mount(box, h('div.design-grid', templateList().map(t =>
        h('button.design-card', {
          type: 'button',
          disabled: !canEdit,
          class: t.key === template ? 'is-active' : null,
          onclick: () => { template = t.key; drawPicker(); drawPreview(); }
        }, [
          h('span.design-card__name', { text: t.label }),
          h('span.design-card__note', { text: t.note })
        ]))));
    };

    drawPicker();
    drawPreview();
    // Switching Normal/Compact should be visible here too.
    previewRedraw = drawPreview;
  }, 0);

  let previewRedraw = null;
  let mode = s.mode;
  setTimeout(() => {
    const box = qs('#modeBox', form);
    const draw = () => mount(box, segmented({
      options: [{ value: 'normal', label: 'Normal' }, { value: 'compact', label: 'Compact — save paper' }],
      value: mode, onChange: v => { mode = v; draw(); if (previewRedraw) previewRedraw(); }
    }));
    if (box) draw();
  }, 0);

  drawGeometry(s);

  return h('div.stack', [
    !canEdit ? alert('info', 'Read-only', 'Printer settings can only be changed by a manager or admin.') : null,
    form,
    canEdit ? h('div.row', [
      h('button.btn.btn--primary.btn--lg', { type: 'button', text: 'Save printer settings',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            await store.updateSetting('printer', Object.assign({}, v, { mode, printerName, template }));
            toastOk('Printer settings saved', `${v.widthMm}mm · ${contentWidthMm(printerSettings(store))}mm print area`);
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ]) : null
  ]);
}

/* ---------------------------------------------------------------- booking */

function bookingTab(ctx) {
  const { store, app } = ctx;
  const canEdit = store.session.can('settings.manage');
  const b = store.setting('booking');
  const a = store.setting('app');

  const form = h('div.stack', [
    card({ title: 'Booking and check-out rules' }, h('div.stack', [
      h('div.form-grid.form-grid--3', [
        field({ label: 'Default nights', name: 'defaultNights', type: 'number', min: 1, max: 30, value: b.defaultNights, disabled: !canEdit }),
        h('div.field', { style: { justifyContent: 'flex-end' } },
          checkbox({ label: 'CNIC or passport required for check-in', name: 'requireCnic', value: b.requireCnic, disabled: !canEdit })),
        h('div.field', { style: { justifyContent: 'flex-end' } },
          checkbox({ label: 'Unit becomes dirty after check-out', name: 'autoDirtyOnCheckout', value: b.autoDirtyOnCheckout !== false, disabled: !canEdit }))
      ]),
      h('div.form-grid.form-grid--2', [
        h('div.field', [
          checkbox({ label: 'Allow check-out with an outstanding balance', name: 'allowCheckoutWithBalance', value: b.allowCheckoutWithBalance, disabled: !canEdit }),
          h('div.field__hint', { text: 'Even when allowed, the receptionist must confirm, and only a role with that permission can complete it.' })
        ]),
        h('div.field', [
          checkbox({ label: 'Warn when a balance is pending', name: 'warnOnBalance', value: b.warnOnBalance, disabled: !canEdit })
        ])
      ]),
      h('div.field', [
        h('div.field__label', { text: 'Weekend days (weekend rate applies)' }),
        h('div.row.row--tight', { id: 'weekendBox' },
          ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) =>
            h('label.check', [
              h('input', { type: 'checkbox', name: 'weekend_' + i, checked: (b.weekendDays || [0, 6]).indexOf(i) > -1, disabled: !canEdit }),
              h('span', { text: label })
            ])))
      ])
    ])),

    card({ title: 'Language' }, h('div.stack', [
      h('div.field', [
        h('div.field__label', { text: 'Interface language' }),
        h('div', { id: 'langBox' })
      ]),
      h('div.text-sm.text-muted', { text: 'Urdu switches the whole interface to right-to-left. Figures, dates and serial numbers stay left-to-right so the ledger stays readable.' })
    ]))
  ]);

  let language = a.language || 'en';
  setTimeout(() => {
    const box = qs('#langBox', form);
    const draw = () => mount(box, segmented({
      options: [{ value: 'en', label: 'English' }, { value: 'ur', label: 'اردو' }],
      value: language,
      onChange: async v => {
        language = v; draw();
        try { await store.updateSetting('app', { language: v }); app.render(); } catch (err) { fail(err); }
      }
    }));
    if (box) draw();
  }, 0);

  return h('div.stack', [
    form,
    canEdit ? h('div.row', [
      h('button.btn.btn--primary.btn--lg', { type: 'button', text: 'Save booking rules',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          const weekendDays = [0, 1, 2, 3, 4, 5, 6].filter(i => v['weekend_' + i]);
          try {
            await store.updateSetting('booking', {
              defaultNights: Number(v.defaultNights) || 1,
              requireCnic: !!v.requireCnic,
              autoDirtyOnCheckout: !!v.autoDirtyOnCheckout,
              allowCheckoutWithBalance: !!v.allowCheckoutWithBalance,
              warnOnBalance: !!v.warnOnBalance,
              weekendDays
            });
            toastOk('Booking rules saved');
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ]) : null
  ]);
}

/* ------------------------------------------------------------------ users */

function usersTab(ctx) {
  const { store } = ctx;
  const canManage = store.session.can('user.manage');
  const users = store.db.all('users').filter(u => !u.archivedAt);

  const me = store.db.get('users', store.session.id);

  return h('div.stack', [
    (me && me.mustChangePassword) ? alert('warn', 'You are still using the default password',
      'Anyone who has seen the manual knows it. Change it now.') : null,

    card({ title: 'Your account' }, h('div.row', [
      h('div', [
        h('div.strong', { text: store.session.name }),
        h('div.text-sm.text-muted', { text: `${me ? me.username : ''} · ${roleLabel(store.session.role)}` })
      ]),
      h('button.btn.push', { type: 'button', text: 'Change my password', onclick: () => changeOwnPassword(ctx) })
    ])),

    !canManage ? alert('info', 'Read-only', 'Only an admin can add or change other users.') : null,

    card({ title: 'Users', note: `${users.length}`, flush: true,
      tools: canManage ? [h('button.btn.btn--sm.btn--primary', { type: 'button', text: 'Add user',
        onclick: () => userForm(ctx, null) })] : [] },
      dataTable({
        columns: [
          { key: 'name', label: 'Name', render: u => h('div', [
              h('div.strong', { text: u.name }),
              h('div.text-xs.text-muted', { text: u.username || '' })
            ]) },
          { key: 'role', label: 'Role', render: u => badge(roleLabel(u.role), u.role === 'admin' ? 'accent' : 'muted') },
          { key: 'pw', label: 'Password', render: u => u.mustChangePassword
              ? badge('Default — must change', 'warn')
              : (u.passwordHash || u.pinHash) ? badge('Set', 'ok') : badge('None', 'due') },
          { key: 'perms', label: 'Permissions', render: u => h('span.text-sm.text-muted', {
              text: `${permissionsFor(u.role).size} of ${PERMISSIONS.length}` }) },
          { key: 'active', label: 'Status', render: u => u.active ? badge('Active', 'ok') : badge('Disabled', 'muted') },
          { key: 'act', label: '', render: u => canManage ? h('div.row.row--tight', [
              h('button.btn.btn--sm', { type: 'button', text: 'Edit', onclick: () => userForm(ctx, u) }),
              h('button.btn.btn--sm', { type: 'button', text: 'Reset password', onclick: () => resetPassword(ctx, u) }),
              u.id !== store.session.id
                ? h('button.btn.btn--sm.btn--ghost', { type: 'button', text: u.active ? 'Disable' : 'Enable',
                    onclick: () => toggleUser(ctx, u) })
                : null
            ]) : null }
        ],
        rows: users,
        empty: emptyState({ title: 'No users', body: 'Add at least one admin.' })
      })),

    card({ title: 'What each role may do' }, h('div.table-wrap', h('table.table.table--compact', [
      h('thead', h('tr', [h('th', { text: 'Action' })].concat(ROLES.map(r => h('th', { text: r.label }))))),
      h('tbody', PERMISSION_GROUPS.map(group => h('tr', [
        h('td', { text: group.label })
      ].concat(ROLES.map(r => {
        const set = permissionsFor(r.id);
        const has = group.keys.some(k => set.has(k));
        const all = group.keys.every(k => set.has(k));
        return h('td', { style: { textAlign: 'center' } },
          all ? h('span', { style: { color: 'var(--ok)' }, text: '✓' })
              : has ? h('span', { style: { color: 'var(--warn)' }, text: 'partial' })
                    : h('span', { style: { color: 'var(--muted-soft)' }, text: '—' }));
      })))))
    ])))
  ]);
}

const PERMISSION_GROUPS = [
  { label: 'See the dashboard', keys: ['view.dashboard'] },
  { label: 'See reports', keys: ['view.reports'] },
  { label: 'Create and edit guests', keys: ['guest.create', 'guest.edit'] },
  { label: 'See full CNIC numbers', keys: ['guest.viewCnic'] },
  { label: 'Create and edit bookings', keys: ['reservation.create', 'reservation.edit'] },
  { label: 'Check in and out', keys: ['stay.checkin', 'stay.checkout'] },
  { label: 'Check out with a balance', keys: ['stay.checkoutWithBalance'] },
  { label: 'Take payments', keys: ['payment.create'] },
  { label: 'Void payments and refund', keys: ['payment.void', 'payment.refund'] },
  { label: 'Manage units', keys: ['unit.create', 'unit.edit', 'unit.archive'] },
  { label: 'Housekeeping and maintenance', keys: ['housekeeping.update', 'maintenance.manage'] },
  { label: 'Expenses', keys: ['expense.create', 'expense.void'] },
  { label: 'Close the day', keys: ['day.close'] },
  { label: 'Reopen a closed day', keys: ['day.reopen'] },
  { label: 'Change settings', keys: ['settings.manage'] },
  { label: 'Manage users', keys: ['user.manage'] },
  { label: 'Backup and restore', keys: ['backup.manage'] },
  { label: 'Erase all data', keys: ['data.reset'] }
];

function userForm(ctx, user) {
  const { store, app } = ctx;
  const form = h('div.stack', [
    h('div.form-grid.form-grid--2', [
      field({ label: 'Name', name: 'name', required: true, value: user ? user.name : '', autofocus: true }),
      field({ label: 'Username', name: 'username', value: user ? user.username : '', placeholder: 'imran' }),
      field({ label: 'Role', name: 'role', type: 'select', value: user ? user.role : 'receptionist',
        options: ROLES.map(r => ({ value: r.id, label: r.label })) }),
      field({ label: user ? 'New password (leave blank to keep)' : 'Password', name: 'password', type: 'password',
        placeholder: 'At least 4 characters', hint: 'Used to sign in.' })
    ]),
    user ? checkbox({ label: 'Active', name: 'active', value: user.active }) : null
  ]);

  const dialog = modal({
    title: user ? `Edit ${user.name}` : 'Add user',
    body: form,
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Save user',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          if (!String(v.name || '').trim()) { toast('warn', 'Name is required'); return; }
          try {
            store.session.require('user.manage');
            const username = String(v.username || '').trim();
            if (!username) { toast('warn', 'A username is required', 'This is what they type to sign in.'); return; }

            const clash = store.db.live('users').find(x =>
              x.id !== (user ? user.id : '') &&
              String(x.username || '').toLowerCase() === username.toLowerCase());
            if (clash) { toast('warn', 'That username is already taken', 'Choose a different one.'); return; }

            let passwordHash = user ? (user.passwordHash || '') : '';
            let salt = user ? user.salt : newSalt();
            let mustChange = user ? !!user.mustChangePassword : false;

            if (v.password) {
              const problem = checkPassword(v.password, username);
              if (problem) { toast('warn', 'Choose a different password', problem); return; }
              salt = newSalt();
              passwordHash = await hashPassword(v.password, salt);
              mustChange = false;
            } else if (!user) {
              toast('warn', 'Set a password', 'A new user needs a password to sign in.');
              return;
            }

            const record = Object.assign({}, user || {}, {
              id: user ? user.id : newId('u'),
              name: String(v.name).trim(),
              username,
              role: v.role,
              salt, passwordHash, pinHash: '',
              mustChangePassword: mustChange,
              active: user ? !!v.active : true,
              archivedAt: null,
              createdAt: user ? user.createdAt : nowIso()
            });
            await store.write(user ? 'user.update' : 'user.create', (tx, log) => {
              tx.put('users', record);
              log('users', record.id, { name: record.name, role: record.role });
            });
            toastOk('User saved', record.name);
            dialog.close();
            app.refresh();
          } catch (err) { fail(err); }
        }) })
    ]
  });
  return dialog;
}

/** An admin resetting someone else's password. */
async function resetPassword(ctx, user) {
  const { store, app } = ctx;
  const next = await promptText({
    title: `Reset the password for ${user.name}?`,
    label: 'New password',
    hint: 'Tell them this password; they can change it themselves afterwards.',
    placeholder: 'At least 4 characters',
    confirmLabel: 'Set password'
  });
  if (next === null) return;
  const problem = checkPassword(next, user.username);
  if (problem) { toast('warn', 'Choose a different password', problem); return; }
  try {
    store.session.require('user.manage');
    await store.setPassword(user.id, next);
    toastOk('Password reset', `${user.name} can now sign in with the new password.`);
    app.refresh();
  } catch (err) { fail(err); }
}

/** Anyone changing their own password. */
function changeOwnPassword(ctx) {
  const { store } = ctx;
  const current = h('input.input', { type: 'password', autocomplete: 'current-password', autofocus: true });
  const next = h('input.input', { type: 'password', autocomplete: 'new-password' });
  const again = h('input.input', { type: 'password', autocomplete: 'new-password' });

  const dialog = modal({
    title: 'Change your password',
    body: h('div.stack', [
      h('div.field', [h('label.field__label', { text: 'Current password' }), current]),
      h('div.field', [h('label.field__label', { text: 'New password' }), next]),
      h('div.field', [h('label.field__label', { text: 'Repeat new password' }), again])
    ]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Change password',
        onclick: e => busy(e.currentTarget, async () => {
          const me = store.db.get('users', store.session.id);
          if (!me) { toast('error', 'Not signed in'); return; }
          if (!await store.verifyPassword(me, current.value)) {
            toast('warn', 'Current password is wrong'); current.focus(); return;
          }
          const problem = checkPassword(next.value, me.username);
          if (problem) { toast('warn', 'Choose a different password', problem); next.focus(); return; }
          if (next.value !== again.value) { toast('warn', 'The two passwords do not match'); again.focus(); return; }
          try {
            await store.setPassword(me.id, next.value);
            toastOk('Password changed');
            dialog.close();
          } catch (err) { fail(err); }
        }) })
    ]
  });
}

async function toggleUser(ctx, user) {
  const { store, app } = ctx;
  const go = await confirm({
    title: user.active ? `Disable ${user.name}?` : `Enable ${user.name}?`,
    message: user.active
      ? 'They will no longer be able to sign in. Everything they recorded stays on the record.'
      : 'They will be able to sign in again.',
    confirmLabel: user.active ? 'Disable' : 'Enable', danger: user.active
  });
  if (!go) return;
  try {
    store.session.require('user.manage');
    const next = Object.assign({}, user, { active: !user.active });
    await store.write('user.toggle', (tx, log) => { tx.put('users', next); log('users', user.id, { active: next.active }); });
    toastOk('User updated', user.name);
    app.refresh();
  } catch (err) { fail(err); }
}

/* ----------------------------------------------------------------- backup */

function backupTab(ctx) {
  const { store, app } = ctx;
  const canManage = store.session.can('backup.manage');
  const autos = readAutoBackups();
  const appSettings = store.setting('app');
  const health = store.health();

  return h('div.stack', [
    !canManage ? alert('info', 'Read-only', 'Only a manager or admin can back up or restore.') : null,

    alert('info', 'Why this matters',
      'Everything lives on this computer only. A backup file is the single thing that survives a reinstall, a disk failure or a stolen machine. Take one at the end of every day and keep it on a USB stick or in a folder you copy elsewhere.'),

    h('div.split.split--2', [
      card({ title: 'Back up' }, h('div.stack', [
        h('div.text-sm', { text: 'Writes every guest, booking, invoice, payment, expense and setting into one JSON file.' }),
        railRows([
          { k: 'Bookings', v: String(health.counts.reservations || 0) },
          { k: 'Guests', v: String(health.counts.guests || 0) },
          { k: 'Payments', v: String(health.counts.payments || 0) },
          { k: 'Invoices', v: String(health.counts.invoices || 0) },
          { k: 'Last change', v: health.updatedAt ? formatDateTime(health.updatedAt) : '—' }
        ]),
        h('button.btn.btn--primary.btn--block', { type: 'button', text: 'Download backup file', disabled: !canManage,
          onclick: e => busy(e.currentTarget, async () => {
            try {
              store.session.require('backup.manage');
              await store.db.flush();
              const backup = buildBackup(store);
              downloadFile(backupFilename(store), JSON.stringify(backup, null, 2));
              toastOk('Backup downloaded', `${Object.values(backup.counts).reduce((a, b) => a + b, 0)} records`);
            } catch (err) { fail(err); }
          }) }),
        h('button.btn.btn--block', { type: 'button', text: 'Take a local safety copy now', disabled: !canManage,
          onclick: async () => {
            try {
              store.session.require('backup.manage');
              const made = saveAutoBackup(store);
              if (made) { await store.updateSetting('app', { lastAutoBackupAt: nowIso() }); toastOk('Safety copy saved', 'Kept in this browser. It is not a substitute for a downloaded file.'); app.refresh(); }
              else warn('Could not save a local copy', 'Storage may be full. Download a backup file instead.');
            } catch (err) { fail(err); }
          } })
      ])),

      card({ title: 'Restore' }, h('div.stack', [
        alert('warn', 'A restore replaces everything',
          'The current data is checked and copied first, and the file is fully validated before anything is written. If the file is wrong, nothing changes.'),
        h('label.btn.btn--block', { style: { cursor: canManage ? 'pointer' : 'not-allowed', opacity: canManage ? 1 : 0.5 } }, [
          'Choose a backup file…',
          h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, disabled: !canManage,
            onchange: e => {
              const file = e.target.files && e.target.files[0];
              e.target.value = '';
              if (file) startRestore(ctx, file);
            } })
        ]),
        h('div.text-xs.text-muted', { text: 'Only files produced by this application are accepted.' })
      ]))
    ]),

    card({ title: 'Automatic local copies', note: `${autos.length} kept`, flush: true }, dataTable({
      compact: true,
      columns: [
        { key: 'at', label: 'Taken', format: 'datetime' },
        { key: 'records', label: 'Records', align: 'end', render: a => String(Object.values(a.counts || {}).reduce((x, y) => x + y, 0)) },
        { key: 'reservations', label: 'Bookings', align: 'end', render: a => String((a.counts || {}).reservations || 0) },
        { key: 'act', label: '', render: a => canManage ? h('div.row.row--tight', [
            h('button.btn.btn--sm', { type: 'button', text: 'Download',
              onclick: () => downloadFile(backupFilename(store, 'auto'), a.payload) }),
            h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Restore',
              onclick: () => startRestoreFromText(ctx, a.payload) })
          ]) : null }
      ],
      rows: autos,
      empty: emptyState({
        title: 'No automatic copies yet',
        body: appSettings.autoBackupEnabled
          ? 'One is taken automatically the first time the app is opened each day.'
          : 'Automatic copies are switched off.'
      })
    })),

    card({ title: 'Automatic backup' }, h('div.stack', [
      checkbox({ label: 'Take a local safety copy once a day', value: appSettings.autoBackupEnabled, disabled: !canManage,
        onChange: async e => {
          try { await store.updateSetting('app', { autoBackupEnabled: e.target.checked }); toastOk('Saved'); }
          catch (err) { fail(err); }
        } }),
      h('div.text-sm.text-muted', {
        text: appSettings.lastAutoBackupAt
          ? `Last automatic copy: ${formatDateTime(appSettings.lastAutoBackupAt)}`
          : 'No automatic copy taken yet.'
      }),
      h('div.text-xs.text-muted', { text: 'Local copies live in this browser. They survive a reload but not a reinstall or a cleared browser — download a file for that.' })
    ]))
  ]);
}

async function startRestore(ctx, file) {
  try {
    const text = await readFileAsText(file);
    startRestoreFromText(ctx, text, file.name);
  } catch (err) { fail(err, 'Restore failed — existing data was not changed.'); }
}

function startRestoreFromText(ctx, text, filename) {
  const { store, app } = ctx;
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    toast('error', 'Restore failed — existing data was not changed.', 'That file is not valid backup data.');
    return;
  }

  const check = validateBackup(parsed);
  const counts = check.summary || {};
  const current = store.health().counts;

  const rows = ['guests', 'units', 'reservations', 'payments', 'invoices', 'expenses'].map(name => ({
    name, incoming: counts[name] || 0, existing: current[name] || 0
  }));

  const dialog = modal({
    title: check.ok ? 'Restore this backup?' : 'This backup cannot be restored',
    subtitle: filename || (parsed.createdAt ? 'Taken ' + formatDateTime(parsed.createdAt) : ''),
    size: 'wide',
    body: h('div.stack', [
      check.ok
        ? alert('warn', 'Everything currently stored will be replaced',
            'A safety copy of the current data is taken first and offered for download if anything goes wrong.')
        : alert('due', 'Restore failed — existing data was not changed.',
            check.errors.join('\n')),

      check.warnings.length ? alert('warn', 'Warnings', check.warnings.join('\n')) : null,

      check.ok ? dataTable({
        compact: true,
        columns: [
          { key: 'name', label: 'Records' },
          { key: 'existing', label: 'Now', align: 'end' },
          { key: 'incoming', label: 'After restore', align: 'end' }
        ],
        rows
      }) : null,

      check.ok && parsed.property ? h('div.text-sm.text-muted', { text: `Backup taken from: ${parsed.property}` }) : null
    ]),
    footer: [
      h('button.btn', { type: 'button', text: check.ok ? 'Cancel' : 'Close', onclick: () => dialog.close() }),
      check.ok ? h('button.btn.btn--danger', { type: 'button', text: 'Replace all data',
        onclick: e => busy(e.currentTarget, async () => {
          try {
            store.session.require('backup.manage');
            const result = await restoreBackup(store, parsed);
            // Hand the pre-restore state back as a file so nothing is ever lost.
            downloadFile(backupFilename(store, 'before-restore'), JSON.stringify(result.safety, null, 2));
            toastOk('Backup restored successfully.',
              'A copy of what was here before has been downloaded as a precaution.');
            dialog.close();
            app.go('dashboard');
          } catch (err) {
            fail(err, 'Restore failed — existing data was not changed.');
          }
        }) }) : null
    ]
  });
  return dialog;
}

/* ------------------------------------------------------------- restaurant */

function inventoryTab(ctx) {
  const { store, app } = ctx;
  const canEdit = store.session.can('settings.manage');
  const cfg = invApi.settings(store);
  const sum = invApi.summary(store);
  const currency = store.currency();

  const form = h('div.stack', [
    card({ title: 'Stock and purchasing' }, h('div.stack', [
      checkbox({ label: 'Enable stock and purchasing', name: 'enabled', value: cfg.enabled, disabled: !canEdit }),
      h('div.field__hint', { text: 'When on, a Stock entry appears in the sidebar for what is on the shelves, what was bought, and what each supplier is owed.' }),
      h('div.form-grid.form-grid--2', [
        field({ label: 'Default department', name: 'defaultDepartment', value: cfg.defaultDepartment,
          disabled: !canEdit, placeholder: 'Kitchen',
          hint: 'Filled in first when someone issues stock.' }),
        h('div.field', { style: { justifyContent: 'flex-end' } },
          checkbox({ label: 'Warn when an item falls to its reorder level', name: 'warnOnLowStock',
            value: cfg.warnOnLowStock, disabled: !canEdit }))
      ])
    ])),
    cfg.enabled
      ? card({ title: 'What is tracked now' }, h('div.kpi-row', [
          kpi({ label: 'Items', value: String(sum.items) }),
          kpi({ label: 'Stock value', value: formatMoney(sum.stockValue, currency) }),
          kpi({ label: 'Need ordering', value: String(sum.lowCount), tone: sum.lowCount ? 'warn' : null }),
          kpi({ label: 'Owed to suppliers', value: formatMoney(sum.suppliersOwed, currency) })
        ]))
      : null
  ]);

  return h('div.stack', [
    !canEdit ? alert('info', 'Read-only', 'Only a manager or admin can change these.') : null,
    form,
    canEdit ? h('div.row', [
      h('button.btn.btn--primary', { type: 'button', text: 'Save stock settings',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            await store.updateSetting('inventory', {
              enabled: !!v.enabled,
              trackKitchenStock: true,
              warnOnLowStock: !!v.warnOnLowStock,
              defaultDepartment: String(v.defaultDepartment || 'Kitchen').trim()
            });
            toastOk('Stock settings saved');
            app.render();
          } catch (err) { fail(err); }
        }) })
    ]) : null
  ]);
}

function restaurantTab(ctx) {
  const { store, app } = ctx;
  const canEdit = store.session.can('settings.manage');
  const cfg = rest.settings(store);
  const categories = rest.listCategories(store);
  const items = rest.listMenuItems(store, { includeArchived: false });
  const tables = rest.listTables(store);
  const currency = store.currency();

  const form = h('div.stack', [
    card({ title: 'Restaurant module' }, h('div.stack', [
      checkbox({ label: 'Enable the restaurant point of sale', name: 'enabled', value: cfg.enabled, disabled: !canEdit }),
      h('div.field__hint', { text: 'When on, a Restaurant entry appears in the sidebar with a table floor plan, menu and order taking.' }),
      h('div.form-grid.form-grid--3', [
        field({ label: 'Service charge %', name: 'serviceChargePercent', type: 'number', min: 0, max: 100, step: '0.5',
          value: cfg.serviceChargePercent, disabled: !canEdit, hint: '0 for none' }),
        h('div.field', { style: { justifyContent: 'flex-end' } },
          checkbox({ label: 'Print a kitchen slip when items are sent', name: 'printKitchenSlip', value: cfg.printKitchenSlip, disabled: !canEdit })),
        h('div.field', { style: { justifyContent: 'flex-end' } },
          checkbox({ label: 'Allow posting an order to a room bill', name: 'allowPostToRoom', value: cfg.allowPostToRoom, disabled: !canEdit }))
      ]),
      field({ label: 'Default area name', name: 'defaultArea', value: cfg.defaultArea, disabled: !canEdit,
        placeholder: 'Main hall' })
    ]))
  ]);

  return h('div.stack', [
    !canEdit ? alert('info', 'Read-only', 'Only a manager or admin can change these.') : null,
    form,
    canEdit ? h('div.row', [
      h('button.btn.btn--primary', { type: 'button', text: 'Save restaurant settings',
        onclick: e => busy(e.currentTarget, async () => {
          const v = formValues(form);
          try {
            await store.updateSetting('restaurant', {
              enabled: !!v.enabled,
              serviceChargePercent: Number(v.serviceChargePercent) || 0,
              printKitchenSlip: !!v.printKitchenSlip,
              allowPostToRoom: !!v.allowPostToRoom,
              defaultArea: String(v.defaultArea || 'Main hall').trim()
            });
            toastOk('Restaurant settings saved');
            app.render();
          } catch (err) { fail(err); }
        }) })
    ]) : null,

    /* --- categories --- */
    card({
      title: 'Menu categories', note: String(categories.length), flush: true,
      tools: canEdit ? [h('button.btn.btn--sm.btn--primary', { type: 'button', text: 'Add category',
        onclick: () => categoryForm(ctx, null) })] : []
    }, categories.length ? dataTable({
      compact: true,
      columns: [
        { key: 'colour', label: '', width: '38px', render: c => h('span', {
            style: { display: 'inline-block', width: '16px', height: '16px', borderRadius: '4px', background: c.colour } }) },
        { key: 'name', label: 'Category' },
        { key: 'nameUr', label: 'Urdu', render: c => c.nameUr ? h('span.ur', { text: c.nameUr }) : '—' },
        { key: 'items', label: 'Items', align: 'end', render: c => String(items.filter(i => i.categoryId === c.id).length) },
        { key: 'act', label: '', render: c => canEdit ? h('div.row.row--tight', [
            h('button.btn.btn--sm', { type: 'button', text: 'Edit', onclick: () => categoryForm(ctx, c) }),
            h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Archive',
              onclick: async () => {
                try { await rest.archiveCategory(store, c.id); toastOk('Category archived'); app.refresh(); }
                catch (err) { fail(err); }
              } })
          ]) : null }
      ],
      rows: categories
    }) : emptyState({ title: 'No categories yet', body: 'Start with Food and Drinks, then add items to them.' })),

    /* --- menu items --- */
    card({
      title: 'Menu items', note: String(items.length), flush: true,
      tools: canEdit ? [h('button.btn.btn--sm.btn--primary', { type: 'button', text: 'Add item',
        onclick: () => menuItemForm(ctx, null) })] : []
    }, items.length ? dataTable({
      currency, compact: true,
      columns: [
        { key: 'code', label: 'Code', render: i => h('span.mono.text-sm', { text: i.code || '—' }) },
        { key: 'name', label: 'Item', render: i => h('div', [
            h('div.strong', { text: i.name }),
            i.nameUr ? h('div.ur.text-xs.text-muted', { text: i.nameUr }) : null
          ]) },
        { key: 'category', label: 'Category', render: i => {
            const c = store.db.get('menuCategories', i.categoryId);
            return c ? h('span.badge', { style: { color: c.colour, background: c.colour + '14', borderColor: c.colour + '33' }, text: c.name }) : '—';
          } },
        { key: 'price', label: 'Price', align: 'end', format: 'money' },
        { key: 'available', label: 'On the menu', render: i => i.available ? badge('Yes', 'ok') : badge('Off', 'muted') },
        { key: 'act', label: '', render: i => canEdit ? h('div.row.row--tight', [
            h('button.btn.btn--sm', { type: 'button', text: 'Edit', onclick: () => menuItemForm(ctx, i) }),
            h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Archive',
              onclick: async () => {
                try { await rest.archiveMenuItem(store, i.id); toastOk('Item archived'); app.refresh(); }
                catch (err) { fail(err); }
              } })
          ]) : null }
      ],
      rows: items
    }) : emptyState({ title: 'No menu items yet', body: 'Add a category first, then the dishes that belong to it.' })),

    /* --- tables --- */
    card({
      title: 'Tables', note: String(tables.length), flush: true,
      tools: canEdit ? [h('button.btn.btn--sm.btn--primary', { type: 'button', text: 'Add table',
        onclick: () => tableForm(ctx, null) })] : []
    }, tables.length ? dataTable({
      compact: true,
      columns: [
        { key: 'code', label: 'Table', render: t => h('span.mono.strong', { text: t.code }) },
        { key: 'name', label: 'Name' },
        { key: 'area', label: 'Area' },
        { key: 'seats', label: 'Seats', align: 'end' },
        { key: 'shape', label: 'Shape' },
        { key: 'status', label: 'Status', render: t => {
            const order = rest.openOrderForTable(store, t.id);
            return order ? badge('In use', 'river') : badge('Free', 'ok');
          } },
        { key: 'act', label: '', render: t => canEdit ? h('div.row.row--tight', [
            h('button.btn.btn--sm', { type: 'button', text: 'Edit', onclick: () => tableForm(ctx, t) }),
            h('button.btn.btn--sm.btn--ghost', { type: 'button', text: 'Archive',
              onclick: async () => {
                try { await rest.archiveTable(store, t.id); toastOk('Table archived'); app.refresh(); }
                catch (err) { fail(err); }
              } })
          ]) : null }
      ],
      rows: tables
    }) : emptyState({ title: 'No tables yet', body: 'Add your tables and they appear as a floor plan on the Restaurant screen.' }))
  ]);
}

function categoryForm(ctx, category) {
  const { store, app } = ctx;
  let colour = category ? category.colour : CATEGORY_COLOURS[0];
  const swatches = h('div.chips');
  const drawSwatches = () => mount(swatches, CATEGORY_COLOURS.map(c => h('button', {
    type: 'button',
    style: {
      width: '30px', height: '30px', borderRadius: 'var(--r)', background: c,
      border: c === colour ? '3px solid var(--ink)' : '1px solid var(--line)', cursor: 'pointer'
    },
    title: c,
    onclick: () => { colour = c; drawSwatches(); }
  })));
  drawSwatches();

  const form = h('div.stack', [
    h('div.form-grid.form-grid--2', [
      field({ label: 'Category name', name: 'name', required: true, autofocus: true,
        value: category ? category.name : '', placeholder: 'Food' }),
      field({ label: 'Name in Urdu', name: 'nameUr', urdu: true, value: category ? category.nameUr : '' })
    ]),
    field({ label: 'Sort order', name: 'sortOrder', type: 'number', value: category ? category.sortOrder : 0,
      hint: 'Lower numbers appear first on the POS.' }),
    h('div.field', [h('div.field__label', { text: 'Colour' }), swatches])
  ]);

  const dialog = modal({
    title: category ? 'Edit category' : 'New category',
    body: form,
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Save',
        onclick: e => busy(e.currentTarget, async () => {
          try {
            await rest.saveCategory(store, Object.assign({ id: category ? category.id : '', colour }, formValues(form)));
            toastOk('Category saved');
            dialog.close(); app.refresh();
          } catch (err) { applyErrors(form, err.fields); fail(err); }
        }) })
    ]
  });
}

function menuItemForm(ctx, item) {
  const { store, app } = ctx;
  const categories = rest.listCategories(store);
  if (!categories.length) {
    toast('warn', 'Add a category first', 'Every menu item belongs to a category.');
    return categoryForm(ctx, null);
  }

  const form = h('div.stack', [
    h('div.form-grid.form-grid--3', [
      field({ label: 'Item name', name: 'name', required: true, autofocus: true,
        value: item ? item.name : '', placeholder: 'Trout Fish', span: 2 }),
      field({ label: 'Name in Urdu', name: 'nameUr', urdu: true, value: item ? item.nameUr : '' }),
      field({ label: 'Category', name: 'categoryId', type: 'select', required: true,
        value: item ? item.categoryId : categories[0].id,
        options: categories.map(c => ({ value: c.id, label: c.name })) }),
      field({ label: 'Short code', name: 'code', mono: true, value: item ? item.code : '', placeholder: 'F01' }),
      field({ label: 'Price', name: 'price', type: 'number', min: 0, required: true, value: item ? item.price : 0 }),
      field({ label: 'Cost (optional)', name: 'cost', type: 'number', min: 0, value: item ? item.cost : 0,
        hint: 'For your own margin figures' }),
      field({ label: 'Sort order', name: 'sortOrder', type: 'number', value: item ? item.sortOrder : 0 })
    ]),
    checkbox({ label: 'Available on the menu right now', name: 'available', value: item ? item.available : true }),
    field({ label: 'Description', name: 'description', type: 'textarea', rows: 2, value: item ? item.description : '' })
  ]);

  const dialog = modal({
    title: item ? 'Edit menu item' : 'New menu item',
    size: 'wide',
    body: form,
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Save',
        onclick: e => busy(e.currentTarget, async () => {
          try {
            await rest.saveMenuItem(store, Object.assign({ id: item ? item.id : '' }, formValues(form)));
            toastOk('Menu item saved');
            dialog.close(); app.refresh();
          } catch (err) { applyErrors(form, err.fields); fail(err); }
        }) })
    ]
  });
}

function tableForm(ctx, table) {
  const { store, app } = ctx;
  const areas = rest.areasOf(store);
  const form = h('div.form-grid.form-grid--2', [
    field({ label: 'Table number', name: 'code', required: true, mono: true, autofocus: true,
      value: table ? table.code : '', placeholder: '1' }),
    field({ label: 'Name (optional)', name: 'name', value: table ? table.name : '', placeholder: 'Corner booth' }),
    field({ label: 'Seats', name: 'seats', type: 'number', min: 1, max: 40, value: table ? table.seats : 4 }),
    field({ label: 'Area', name: 'area', value: table ? table.area : (areas[0] || rest.settings(store).defaultArea),
      placeholder: 'Main hall', hint: areas.length ? 'Existing: ' + areas.join(', ') : null }),
    field({ label: 'Shape', name: 'shape', type: 'select', value: table ? table.shape : 'square',
      options: [{ value: 'square', label: 'Square' }, { value: 'round', label: 'Round' }, { value: 'rect', label: 'Rectangle' }] })
  ]);

  const dialog = modal({
    title: table ? 'Edit table ' + table.code : 'New table',
    body: form,
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Save',
        onclick: e => busy(e.currentTarget, async () => {
          try {
            await rest.saveTable(store, Object.assign({ id: table ? table.id : '' }, formValues(form)));
            toastOk('Table saved');
            dialog.close(); app.refresh();
          } catch (err) { applyErrors(form, err.fields); fail(err); }
        }) })
    ]
  });
}

/* --------------------------------------------------------------- whatsapp */

function whatsappTab(ctx) { return whatsappPanel(ctx); }

/* ---------------------------------------------------------------- licence */

function licenceTab(ctx) {
  const { app } = ctx;
  const holder = h('div.stack', h('div.text-sm.text-muted', { text: 'Checking licence\u2026' }));
  host.licenceStatus().then(status => {
    host.setLicence(status);
    mount(holder, [
      activationCard(status, () => app.refresh(), { inline: true }),
      !host.isDesktop ? alert('info', 'Browser preview',
        'Licensing applies to the installed desktop application. Run the installer to activate a licence.') : null
    ]);
  }).catch(err => {
    mount(holder, alert('due', 'Could not read the licence', String(err && err.message || err)));
  });
  return holder;
}

/* ------------------------------------------------------------------ about */

function aboutTab(ctx) {
  const { store } = ctx;
  const health = store.health();
  const canReset = store.session.can('data.reset');

  return h('div.stack', [
    h('div.kpi-grid', Object.keys(health.counts)
      .filter(k => health.counts[k] > 0)
      .map(k => kpi({ label: k, value: String(health.counts[k]) }))),

    card({ title: 'Storage' }, railRows([
      { k: 'Engine', v: health.storage === 'indexeddb' ? 'IndexedDB (full local database)' : 'Browser local storage (fallback)' },
      { k: 'Data version', v: String(health.schemaVersion) },
      { k: 'Created', v: health.createdAt ? formatDateTime(health.createdAt) : '—' },
      { k: 'Last change', v: health.updatedAt ? formatDateTime(health.updatedAt) : '—' },
      { k: 'Signed in as', v: `${store.session.name} (${roleLabel(store.session.role)})` }
    ])),

    health.degraded ? alert('warn', 'Running on fallback storage',
      'IndexedDB is not available here — usually because the app was opened directly from a file. It still works, but capacity is smaller. Serving the folder over a local web server, or running it as a desktop app, restores the full database.') : null,

    card({ title: 'About' }, h('div.stack.stack--sm', [
      h('div.text-sm', { text: 'Offline Accommodation Management System — hotel, guest house, resort, apartments, villas, cottages and shared beds.' }),
      h('div.text-sm.text-muted', { text: 'Every feature works without an internet connection. No data leaves this computer.' }),
      h('div.row', { style: { marginTop: '8px' } }, [
        h('img', { src: 'assets/brand-digital-target.jpg', alt: '', width: 36, height: 36, style: { borderRadius: 'var(--r)' } }),
        h('div', [
          h('div.text-xs.text-muted', { style: { textTransform: 'uppercase', letterSpacing: '0.08em' }, text: 'Software by' }),
          h('div.strong', { text: 'Digital Target' })
        ])
      ])
    ])),

    canReset ? card({ title: 'Danger zone' }, h('div.stack', [
      alert('due', 'Erase all data',
        'Deletes every guest, booking, invoice and payment on this computer. Take a backup first — this cannot be undone.'),
      h('button.btn.btn--danger', { type: 'button', text: 'Erase all data',
        onclick: () => confirmReset(ctx) })
    ])) : null
  ]);
}

async function confirmReset(ctx) {
  const { store } = ctx;
  const health = store.health();
  const total = Object.values(health.counts).reduce((a, b) => a + b, 0);

  const first = await confirm({
    title: 'Erase everything on this computer?',
    message: `${total} records will be deleted permanently: guests, bookings, invoices, payments, expenses and settings.`,
    detail: 'Download a backup first if there is any chance this data will be wanted again.',
    detailTitle: 'This cannot be undone',
    tone: 'due', danger: true, confirmLabel: 'Continue'
  });
  if (!first) return;

  const typed = await promptText({
    title: 'Type ERASE to confirm',
    label: 'Confirmation',
    placeholder: 'ERASE',
    requiredMessage: 'Type ERASE to continue.',
    danger: true, confirmLabel: 'Erase all data'
  });
  if (typed === null) return;
  if (String(typed).trim().toUpperCase() !== 'ERASE') {
    toast('warn', 'Not erased', 'The confirmation did not match.');
    return;
  }

  try {
    store.session.require('data.reset');
    // The outgoing data is handed back as a file before anything is removed.
    const safety = buildBackup(store);
    downloadFile(backupFilename(store, 'before-erase'), JSON.stringify(safety, null, 2));
    const empty = {};
    Object.keys(store.db.collections).forEach(k => { empty[k] = []; });
    await store.db.replaceAll(empty, { schemaVersion: health.schemaVersion, createdAt: nowIso() });
    toastOk('All data erased', 'A copy of what was there has been downloaded.');
    setTimeout(() => window.location.reload(), 900);
  } catch (err) { fail(err); }
}
