/**
 * Digital Target — licence panel.
 *
 * Issues the keys that unlock Hotel Register, and keeps track of which
 * computer each one is running on. Everything here is one Firestore
 * collection; the desktop app reads a single document from it and then runs
 * offline for good.
 */

import { h, clear } from '../lib/dom.js';
import * as model from '../lib/licence-model.js';
import config from '../lib/firebase-config.js';
import { Panel } from './firebase.js';

const panel = new Panel(config);

const state = {
  screen: 'signin',
  licences: [],
  loading: false,
  search: '',
  filter: 'all',
  selected: null,
  error: ''
};

const root = document.getElementById('root');

/* ------------------------------------------------------------- utilities */

const money = n => 'Rs ' + Number(n || 0).toLocaleString('en-PK');
const shortDate = s => (s ? String(s).slice(0, 10) : '');

/** Pakistani numbers written five different ways, all reaching one form. */
function waNumber(phone) {
  let d = String(phone || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '92' + d.slice(1);
  else if (d.length === 10 && d.startsWith('3')) d = '92' + d;
  return d;
}

function toast(message, kind) {
  const el = h('div.toast' + (kind ? '.toast--' + kind : ''), { text: message });
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('is-out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast((what || 'Copied') + ' copied', 'ok');
  } catch {
    // Clipboard access is refused on plain http; fall back to a selection.
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast((what || 'Copied') + ' copied', 'ok'); }
    catch { toast('Copy it by hand: ' + text); }
    ta.remove();
  }
}

/** What a licence is doing right now, in one word. */
function statusOf(rec) {
  if (rec.revoked) return 'revoked';
  if (rec.expiresAt && model.daysUntil(rec.expiresAt) < 0) return 'expired';
  if (!rec.machineId) return 'unused';
  if (rec.expiresAt && model.daysUntil(rec.expiresAt) <= 14) return 'expiring';
  return 'active';
}

const STATUS_LABEL = {
  active: 'Active', expiring: 'Expiring', expired: 'Expired',
  revoked: 'Revoked', unused: 'Not activated'
};

/* ------------------------------------------------------------------ boot */

function render() {
  clear(root);
  root.appendChild(state.screen === 'signin' ? signInScreen() : panelScreen());
  updateCount();
}

/** The "12 of 40" beside the search box, set once the nodes are in the page. */
function updateCount() {
  const el = document.getElementById('count');
  if (el) el.textContent = visibleLicences().length + ' of ' + state.licences.length;
}

function go(screen) { state.screen = screen; render(); }

/* -------------------------------------------------------------- sign in */

function signInScreen() {
  let email = panel.email || '';
  let password = '';
  let busy = false;
  const msg = h('p.signin__msg');

  const submit = async (ev) => {
    if (ev) ev.preventDefault();
    if (busy) return;
    msg.className = 'signin__msg';
    if (!email.trim() || !password) { msg.classList.add('is-bad'); msg.textContent = 'Enter the email and password.'; return; }
    busy = true; button.disabled = true; button.textContent = 'Signing in…';
    try {
      await panel.signIn(email, password);
      await loadLicences();
      go('list');
    } catch (err) {
      msg.classList.add('is-bad');
      msg.textContent = err.message;
    } finally {
      busy = false; button.disabled = false; button.textContent = 'Sign in';
    }
  };

  const button = h('button.btn.btn--primary.btn--block', { type: 'submit', text: 'Sign in' });

  const form = h('form.signin__form', { onsubmit: submit }, [
    h('label.field', [
      h('span.field__label', { text: 'Email address' }),
      h('input.input', { type: 'email', autocomplete: 'username', value: email, placeholder: 'you@gmail.com',
        oninput: e => { email = e.target.value; } })
    ]),
    h('label.field', [
      h('span.field__label', { text: 'Password' }),
      h('input.input', { type: 'password', autocomplete: 'current-password',
        oninput: e => { password = e.target.value; } })
    ]),
    msg,
    button,
    h('button.linky', { type: 'button', text: 'Forgot the password?', onclick: async () => {
      if (!email.trim()) { msg.className = 'signin__msg is-bad'; msg.textContent = 'Type the email address first.'; return; }
      try {
        await panel.sendPasswordReset(email);
        msg.className = 'signin__msg is-ok';
        msg.textContent = 'A reset link is on its way to ' + email + '.';
      } catch (err) { msg.className = 'signin__msg is-bad'; msg.textContent = err.message; }
    } })
  ]);

  return h('div.signin', [
    h('div.signin__card', [
      h('div.signin__brand', [
        h('div.brand-mark', { text: 'DT' }),
        h('div', [
          h('h1.signin__title', { text: 'Licence Panel' }),
          h('p.signin__sub', { text: 'Digital Target · Hotel Register' })
        ])
      ]),
      form,
      h('p.signin__foot', { text: 'Accounts are created in the Firebase console under Authentication, then added to the "admins" collection.' })
    ])
  ]);
}

/* ---------------------------------------------------------------- panel */

async function loadLicences() {
  state.loading = true;
  state.error = '';
  try {
    state.licences = await panel.listLicences(500);
  } catch (err) {
    state.error = err.message;
    state.licences = [];
  } finally {
    state.loading = false;
  }
}

function panelScreen() {
  return h('div.shell', [
    topbar(),
    h('main.main', [
      state.error ? h('div.banner.banner--bad', [
        h('span', { text: state.error }),
        h('button.btn.btn--sm', { type: 'button', text: 'Try again',
          onclick: async () => { await loadLicences(); render(); } })
      ]) : null,
      statsRow(),
      toolbar(),
      state.loading ? h('div.empty', { text: 'Loading licences…' }) : licenceTable()
    ]),
    state.selected ? detailDrawer(state.selected) : null
  ]);
}

function topbar() {
  return h('header.topbar', [
    h('div.topbar__brand', [
      h('div.brand-mark', { text: 'DT' }),
      h('div', [
        h('strong.topbar__title', { text: 'Licence Panel' }),
        h('span.topbar__sub', { text: config.projectId })
      ])
    ]),
    h('div.topbar__right', [
      h('button.btn.btn--primary', { type: 'button', text: '+ New licence', onclick: () => newLicenceDialog() }),
      h('button.btn', { type: 'button', text: 'Refresh',
        onclick: async () => { await loadLicences(); render(); } }),
      h('div.who', [
        h('span.who__mail', { text: panel.email }),
        h('button.linky', { type: 'button', text: 'Change password', onclick: () => changePasswordDialog() }),
        h('button.linky', { type: 'button', text: 'Sign out',
          onclick: () => { panel.signOut(); state.licences = []; state.selected = null; go('signin'); } })
      ])
    ])
  ]);
}

function statsRow() {
  const by = { active: 0, expiring: 0, expired: 0, revoked: 0, unused: 0 };
  state.licences.forEach(r => { by[statusOf(r)]++; });
  const cards = [
    { key: 'all', label: 'All licences', value: state.licences.length, tone: 'ink' },
    { key: 'active', label: 'Running', value: by.active, tone: 'ok' },
    { key: 'expiring', label: 'Expiring soon', value: by.expiring, tone: 'warn' },
    { key: 'expired', label: 'Expired', value: by.expired, tone: 'bad' },
    { key: 'unused', label: 'Not activated', value: by.unused, tone: 'muted' },
    { key: 'revoked', label: 'Revoked', value: by.revoked, tone: 'bad' }
  ];
  return h('div.stats', cards.map(c =>
    h('button.stat', {
      type: 'button',
      'data-tone': c.tone,
      class: state.filter === c.key ? 'is-active' : null,
      onclick: () => { state.filter = c.key; render(); }
    }, [
      h('span.stat__value', { text: String(c.value) }),
      h('span.stat__label', { text: c.label })
    ])));
}

function toolbar() {
  return h('div.toolbar', [
    h('input.input.input--search', {
      type: 'search', value: state.search,
      placeholder: 'Search by business, owner, phone or key…',
      oninput: e => { state.search = e.target.value; renderTableOnly(); }
    }),
    h('span.toolbar__count', { id: 'count' })
  ]);
}

/** Re-renders just the rows, so typing in the search box never loses focus. */
function renderTableOnly() {
  const old = document.querySelector('.table-wrap, .empty--rows');
  if (!old) { render(); return; }
  old.replaceWith(licenceTable());
  updateCount();
}

function visibleLicences() {
  const q = state.search.trim().toLowerCase();
  const keyQ = model.normaliseKey(state.search);
  return state.licences.filter(r => {
    if (state.filter !== 'all' && statusOf(r) !== state.filter) return false;
    if (!q) return true;
    if (keyQ && String(r.docId || '').startsWith(keyQ)) return true;
    return [r.businessName, r.ownerName, r.phone, r.city, r.email, r.notes]
      .some(v => String(v || '').toLowerCase().includes(q));
  });
}

function licenceTable() {
  const rows = visibleLicences();

  if (!rows.length) {
    return h('div.empty.empty--rows', [
      h('p', { text: state.licences.length ? 'No licence matches that.' : 'No licences yet.' }),
      h('button.btn.btn--primary', { type: 'button', text: 'Create the first licence', onclick: () => newLicenceDialog() })
    ]);
  }

  return h('div.table-wrap', [
    h('table.table', [
      h('thead', h('tr', [
        h('th', { text: 'Business' }),
        h('th', { text: 'Owner' }),
        h('th', { text: 'Phone' }),
        h('th', { text: 'Key' }),
        h('th', { text: 'Plan' }),
        h('th', { text: 'Expires' }),
        h('th', { text: 'Status' })
      ])),
      h('tbody', rows.map(rec => {
        const status = statusOf(rec);
        return h('tr.row', { onclick: () => { state.selected = rec; render(); } }, [
          h('td', [
            h('strong', { text: rec.businessName || '—' }),
            rec.city ? h('span.row__sub', { text: rec.city }) : null
          ]),
          h('td', { text: rec.ownerName || '—' }),
          h('td.mono', { text: rec.phone || '—' }),
          h('td.mono.key', { text: model.formatKey(rec.docId || rec.key || '') }),
          h('td', { text: model.planByKey(rec.plan).label }),
          h('td.mono', { text: rec.expiresAt ? shortDate(rec.expiresAt) : 'Never' }),
          h('td', h('span.pill', { 'data-status': status, text: STATUS_LABEL[status] }))
        ]);
      }))
    ])
  ]);
}

/* -------------------------------------------------------------- drawer */

function detailDrawer(rec) {
  const d = model.describeRecord(rec);
  const status = statusOf(rec);
  const close = () => { state.selected = null; render(); };

  const row = (label, value, extra) => h('div.kv', [
    h('span.kv__k', { text: label }),
    h('span.kv__v', typeof value === 'string' ? { text: value } : null, typeof value === 'string' ? null : value),
    extra || null
  ]);

  const act = async (label, fn) => {
    try { await fn(); await loadLicences();
      state.selected = state.licences.find(r => r.docId === rec.docId) || null;
      render(); toast(label, 'ok');
    } catch (err) { toast(err.message, 'bad'); }
  };

  const keyText = model.formatKey(rec.docId || rec.key || '');

  return h('div.drawer-wrap', [
    h('div.drawer__scrim', { onclick: close }),
    h('aside.drawer', [
      h('div.drawer__head', [
        h('div', [
          h('h2.drawer__title', { text: rec.businessName || 'Licence' }),
          h('span.pill', { 'data-status': status, text: STATUS_LABEL[status] })
        ]),
        h('button.icon-btn', { type: 'button', text: '✕', title: 'Close', onclick: close })
      ]),

      h('div.keybox', [
        h('span.keybox__label', { text: 'Licence key' }),
        h('span.keybox__key', { text: keyText }),
        h('div.keybox__acts', [
          h('button.btn.btn--sm', { type: 'button', text: 'Copy key', onclick: () => copy(keyText, 'Key') }),
          rec.phone ? h('a.btn.btn--sm.btn--wa', {
            href: 'https://wa.me/' + waNumber(rec.phone) + '?text=' + encodeURIComponent(whatsappText(rec, keyText)),
            target: '_blank', rel: 'noopener', text: 'Send on WhatsApp'
          }) : null
        ])
      ]),

      h('section.drawer__section', [
        h('h3.drawer__h', { text: 'Customer' }),
        row('Owner', rec.ownerName || '—'),
        row('Phone', rec.phone || '—'),
        row('City', rec.city || '—'),
        row('Email', rec.email || '—')
      ]),

      h('section.drawer__section', [
        h('h3.drawer__h', { text: 'Licence' }),
        row('Plan', d.plan),
        row('Issued', shortDate(rec.issuedAt) || '—'),
        row('Expires', rec.expiresAt ? shortDate(rec.expiresAt) + daysNote(rec.expiresAt) : 'Never'),
        row('Units', d.units),
        row('Users', d.users),
        row('Features', h('span.chips', d.featureLabels.map(l => h('span.chip', { text: l }))))
      ]),

      h('section.drawer__section', [
        h('h3.drawer__h', { text: 'Computer' }),
        rec.machineId
          ? h('div', [
              row('Activated', shortDate(rec.activatedAt) || '—'),
              row('Last seen', shortDate(rec.lastSeenAt) || '—'),
              row('Machine code', h('code.mono.small', { text: rec.machineCode || rec.machineId.slice(0, 16) })),
              h('p.note', { text: 'This licence is locked to that computer. Release it if the customer has changed machines — the next computer to activate will claim it.' }),
              h('button.btn.btn--sm', { type: 'button', text: 'Release the computer', onclick: () =>
                confirmThen('Release this licence from its computer? The customer will be able to activate it on a new one.',
                  () => act('Released', () => panel.patchDoc(config.licencesCollection, rec.docId,
                    { machineId: '', machineCode: '', activatedAt: '' }))) })
            ])
          : h('p.note', { text: 'Not activated yet. The first computer to enter this key will claim it.' })
      ]),

      rec.notes ? h('section.drawer__section', [
        h('h3.drawer__h', { text: 'Notes' }),
        h('p.note', { text: rec.notes })
      ]) : null,

      h('div.drawer__acts', [
        h('button.btn', { type: 'button', text: 'Edit details', onclick: () => editLicenceDialog(rec) }),
        h('button.btn', { type: 'button', text: 'Renew / extend', onclick: () => renewDialog(rec) }),
        rec.revoked
          ? h('button.btn', { type: 'button', text: 'Restore licence', onclick: () =>
              act('Restored', () => panel.patchDoc(config.licencesCollection, rec.docId, { revoked: false })) })
          : h('button.btn.btn--danger-soft', { type: 'button', text: 'Revoke', onclick: () =>
              confirmThen('Revoke this licence? The software will stop working the next time it reaches the internet.',
                () => act('Revoked', () => panel.patchDoc(config.licencesCollection, rec.docId, { revoked: true }))) }),
        h('button.btn.btn--danger', { type: 'button', text: 'Delete', onclick: () =>
          confirmThen('Delete this licence for good? Revoking is usually the right choice — a deleted record cannot be looked up later.',
            async () => {
              await panel.deleteDoc(config.licencesCollection, rec.docId);
              state.selected = null;
              await loadLicences(); render(); toast('Deleted', 'ok');
            }) })
      ])
    ])
  ]);
}

function daysNote(expiresAt) {
  const left = model.daysUntil(expiresAt);
  if (left === null) return '';
  if (left < 0) return `  (${Math.abs(left)} day(s) ago)`;
  return `  (${left} day(s) left)`;
}

function whatsappText(rec, keyText) {
  return [
    'Assalam-o-Alaikum ' + (rec.ownerName || '') + ',',
    '',
    'Your Hotel Register licence for ' + (rec.businessName || 'your property') + ' is ready.',
    '',
    'Licence key: ' + keyText,
    rec.expiresAt ? 'Valid until: ' + shortDate(rec.expiresAt) : 'Valid: no expiry',
    '',
    'Open the software, type this key on the activation screen and press Activate. It needs the internet once; after that it works fully offline.',
    '',
    'Digital Target'
  ].join('\n');
}

/* ------------------------------------------------------------- dialogs */

function modal(title, body, footer) {
  const wrap = h('div.modal-wrap', [
    h('div.modal__scrim', { onclick: () => wrap.remove() }),
    h('div.modal', [
      h('div.modal__head', [
        h('h2.modal__title', { text: title }),
        h('button.icon-btn', { type: 'button', text: '✕', onclick: () => wrap.remove() })
      ]),
      h('div.modal__body', body),
      h('div.modal__foot', footer)
    ])
  ]);
  document.body.appendChild(wrap);
  const first = wrap.querySelector('input, select, textarea, button');
  if (first) first.focus();
  return wrap;
}

function confirmThen(question, fn) {
  const wrap = modal('Are you sure?', [h('p.note', { text: question })], [
    h('button.btn', { type: 'button', text: 'Cancel', onclick: () => wrap.remove() }),
    h('button.btn.btn--danger', { type: 'button', text: 'Yes, go ahead',
      onclick: async () => { wrap.remove(); await fn(); } })
  ]);
}

function field(label, input, hint) {
  return h('label.field', [
    h('span.field__label', { text: label }),
    input,
    hint ? h('span.field__hint', { text: hint }) : null
  ]);
}

/** The form behind both "new" and "edit", so the two can never drift apart. */
function licenceFields(draft, opts) {
  const o = opts || {};
  const set = (k) => e => { draft[k] = e.target.value; };
  const planSelect = h('select.input', {
    onchange: e => {
      draft.plan = e.target.value;
      const plan = model.planByKey(draft.plan);
      draft.maxUnits = plan.maxUnits;
      draft.maxUsers = plan.maxUsers;
      draft.features = (model.PLAN_FEATURES[plan.key] || []).slice();
      draft.expiresAt = plan.days ? model.addDaysStr(plan.days) : '';
      if (o.onPlanChange) o.onPlanChange();
    }
  }, model.PLANS.map(p => h('option', { value: p.key, selected: p.key === draft.plan, text: p.label })));

  return [
    h('div.grid2', [
      field('Hotel / business name *', h('input.input', { value: draft.businessName, placeholder: 'Kalam Continental', oninput: set('businessName') })),
      field('Owner name *', h('input.input', { value: draft.ownerName, placeholder: 'Zahid Ullah', oninput: set('ownerName') }))
    ]),
    h('div.grid2', [
      field('Phone number *', h('input.input', { value: draft.phone, placeholder: '0300-1234567', inputmode: 'tel', oninput: set('phone') }),
        'Used for the WhatsApp message that delivers the key.'),
      field('City', h('input.input', { value: draft.city, placeholder: 'Swat', oninput: set('city') }))
    ]),
    h('div.grid2', [
      field('Email', h('input.input', { type: 'email', value: draft.email, oninput: set('email') })),
      field('Plan', planSelect)
    ]),
    h('div.grid3', [
      field('Expires on', h('input.input', { type: 'date', value: draft.expiresAt, oninput: set('expiresAt') }), 'Leave empty for no expiry.'),
      field('Max units', h('input.input', { type: 'number', min: '0', value: String(draft.maxUnits), oninput: e => { draft.maxUnits = Number(e.target.value) || 0; } }), '0 means unlimited.'),
      field('Max users', h('input.input', { type: 'number', min: '0', value: String(draft.maxUsers), oninput: e => { draft.maxUsers = Number(e.target.value) || 0; } }), '0 means unlimited.')
    ]),
    field('Features', h('div.checks', model.FEATURES.map(f =>
      h('label.check', [
        h('input', { type: 'checkbox', checked: draft.features.includes(f.key),
          onchange: e => {
            if (e.target.checked) { if (!draft.features.includes(f.key)) draft.features.push(f.key); }
            else draft.features = draft.features.filter(k => k !== f.key);
          } }),
        h('span', { text: f.label })
      ])))),
    field('Notes', h('textarea.input', { rows: '2', value: draft.notes, oninput: set('notes') }), 'Only you see this — invoice number, reseller, anything.')
  ];
}

function validate(draft) {
  if (!draft.businessName.trim()) return 'Enter the hotel or business name.';
  if (!draft.ownerName.trim()) return 'Enter the owner name.';
  if (!draft.phone.trim()) return 'Enter the phone number — the key is delivered on WhatsApp.';
  if (waNumber(draft.phone).length < 11) return 'That phone number looks too short.';
  return '';
}

function newLicenceDialog() {
  const draft = Object.assign(model.blankRecord(), {
    plan: 'standard',
    expiresAt: model.addDaysStr(model.planByKey('standard').days),
    features: model.PLAN_FEATURES.standard.slice()
  });
  const msg = h('p.form__msg');
  let body;

  const redraw = () => {
    const fresh = h('div', licenceFields(draft, { onPlanChange: redraw }));
    body.replaceWith(fresh);
    body = fresh;
  };
  body = h('div', licenceFields(draft, { onPlanChange: redraw }));

  const save = h('button.btn.btn--primary', { type: 'button', text: 'Create licence', onclick: async () => {
    const problem = validate(draft);
    if (problem) { msg.className = 'form__msg is-bad'; msg.textContent = problem; return; }
    save.disabled = true; save.textContent = 'Creating…';
    try {
      const rec = await createLicence(draft);
      wrap.remove();
      await loadLicences();
      state.selected = state.licences.find(r => r.docId === rec.docId) || rec;
      render();
      toast('Licence ' + model.formatKey(rec.docId) + ' created', 'ok');
    } catch (err) {
      msg.className = 'form__msg is-bad'; msg.textContent = err.message;
      save.disabled = false; save.textContent = 'Create licence';
    }
  } });

  const wrap = modal('New licence', [body, msg], [
    h('button.btn', { type: 'button', text: 'Cancel', onclick: () => wrap.remove() }),
    save
  ]);
}

/**
 * Generates a key and writes it. A taken id comes back as 409, so a collision
 * retries rather than silently overwriting somebody else's licence.
 */
async function createLicence(draft) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = model.generateKey();
    const docId = model.keyToDocId(key);
    const record = Object.assign(model.blankRecord(), draft, {
      key: model.formatKey(key),
      issuedAt: new Date().toISOString(),
      issuedBy: panel.email,
      machineId: '', machineCode: '', activatedAt: '', lastSeenAt: '',
      revoked: false
    });
    try {
      const saved = await panel.createDoc(config.licencesCollection, docId, record);
      saved.docId = docId;
      return saved;
    } catch (err) {
      if (err.status === 409) continue;               // astronomically unlikely
      throw err;
    }
  }
  throw new Error('Could not find a free licence key. Try again.');
}

function editLicenceDialog(rec) {
  const draft = Object.assign(model.blankRecord(), rec, {
    features: Array.isArray(rec.features) ? rec.features.slice() : (model.PLAN_FEATURES[rec.plan] || []).slice(),
    expiresAt: shortDate(rec.expiresAt)
  });
  const msg = h('p.form__msg');
  let body;
  const redraw = () => {
    const fresh = h('div', licenceFields(draft, { onPlanChange: redraw }));
    body.replaceWith(fresh); body = fresh;
  };
  body = h('div', licenceFields(draft, { onPlanChange: redraw }));

  const save = h('button.btn.btn--primary', { type: 'button', text: 'Save changes', onclick: async () => {
    const problem = validate(draft);
    if (problem) { msg.className = 'form__msg is-bad'; msg.textContent = problem; return; }
    save.disabled = true; save.textContent = 'Saving…';
    try {
      await panel.patchDoc(config.licencesCollection, rec.docId, {
        businessName: draft.businessName, ownerName: draft.ownerName, phone: draft.phone,
        city: draft.city, email: draft.email, plan: draft.plan, expiresAt: draft.expiresAt,
        maxUnits: draft.maxUnits, maxUsers: draft.maxUsers, features: draft.features, notes: draft.notes
      });
      wrap.remove();
      await loadLicences();
      state.selected = state.licences.find(r => r.docId === rec.docId) || null;
      render(); toast('Saved', 'ok');
    } catch (err) {
      msg.className = 'form__msg is-bad'; msg.textContent = err.message;
      save.disabled = false; save.textContent = 'Save changes';
    }
  } });

  const wrap = modal('Edit licence', [body, msg], [
    h('button.btn', { type: 'button', text: 'Cancel', onclick: () => wrap.remove() }),
    save
  ]);
}

function renewDialog(rec) {
  // Renewing from today would quietly rob a customer who renews early, so the
  // extension runs from whichever is later: today, or the current expiry.
  const from = (rec.expiresAt && model.daysUntil(rec.expiresAt) > 0) ? shortDate(rec.expiresAt) : model.todayStr();
  let until = addDaysTo(from, 365);
  const msg = h('p.form__msg');
  const preview = h('p.note');
  const input = h('input.input', { type: 'date', value: until, oninput: e => { until = e.target.value; showPreview(); } });

  const showPreview = () => {
    preview.textContent = until
      ? 'New expiry: ' + until + ' (' + (model.daysUntil(until) || 0) + ' day(s) from today)'
      : 'No expiry — the licence will never lapse.';
  };
  showPreview();

  const quick = days => h('button.btn.btn--sm', { type: 'button', text: days + ' days', onclick: () => {
    until = addDaysTo(from, days); input.value = until; showPreview();
  } });

  const save = h('button.btn.btn--primary', { type: 'button', text: 'Renew', onclick: async () => {
    save.disabled = true; save.textContent = 'Saving…';
    try {
      await panel.patchDoc(config.licencesCollection, rec.docId, { expiresAt: until || '', revoked: false });
      wrap.remove();
      await loadLicences();
      state.selected = state.licences.find(r => r.docId === rec.docId) || null;
      render(); toast('Renewed', 'ok');
    } catch (err) {
      msg.className = 'form__msg is-bad'; msg.textContent = err.message;
      save.disabled = false; save.textContent = 'Renew';
    }
  } });

  const wrap = modal('Renew licence', [
    h('p.note', { text: rec.expiresAt
      ? 'Currently expires ' + shortDate(rec.expiresAt) + '. The extension runs from ' + from + ', so renewing early loses nothing.'
      : 'This licence has no expiry. Setting a date will give it one.' }),
    h('div.row-btns', [quick(30), quick(90), quick(180), quick(365), quick(730),
      h('button.btn.btn--sm', { type: 'button', text: 'No expiry', onclick: () => { until = ''; input.value = ''; showPreview(); } })]),
    field('Expires on', input),
    preview,
    msg
  ], [
    h('button.btn', { type: 'button', text: 'Cancel', onclick: () => wrap.remove() }),
    save
  ]);
}

function addDaysTo(dateStr, days) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + Number(days || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function changePasswordDialog() {
  let a = '', b = '';
  const msg = h('p.form__msg');
  const save = h('button.btn.btn--primary', { type: 'button', text: 'Change password', onclick: async () => {
    if (a.length < 6) { msg.className = 'form__msg is-bad'; msg.textContent = 'Use at least 6 characters.'; return; }
    if (a !== b) { msg.className = 'form__msg is-bad'; msg.textContent = 'The two passwords do not match.'; return; }
    save.disabled = true; save.textContent = 'Saving…';
    try { await panel.changePassword(a); wrap.remove(); toast('Password changed', 'ok'); }
    catch (err) {
      msg.className = 'form__msg is-bad'; msg.textContent = err.message;
      save.disabled = false; save.textContent = 'Change password';
    }
  } });

  const wrap = modal('Change panel password', [
    field('New password', h('input.input', { type: 'password', autocomplete: 'new-password', oninput: e => { a = e.target.value; } })),
    field('Repeat it', h('input.input', { type: 'password', autocomplete: 'new-password', oninput: e => { b = e.target.value; } })),
    msg
  ], [
    h('button.btn', { type: 'button', text: 'Cancel', onclick: () => wrap.remove() }),
    save
  ]);
}

/* ------------------------------------------------------------------ run */

(async function start() {
  if (panel.signedIn) {
    try {
      await panel.token();
      await loadLicences();
      state.screen = 'list';
    } catch {
      panel.signOut();
      state.screen = 'signin';
    }
  }
  render();
})();

// Escape closes the topmost layer.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const modalWrap = document.querySelector('.modal-wrap:last-of-type');
  if (modalWrap) { modalWrap.remove(); return; }
  if (state.selected) { state.selected = null; render(); }
});
