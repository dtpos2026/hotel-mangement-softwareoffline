/**
 * End-to-end checks: the demo seed exercises every domain service the way the
 * UI does, and every UI module is imported so a broken import or a typo in an
 * export name fails here rather than in the browser.
 */

import { installBrowserGlobals, suite, ok, eq, throws, report } from './harness.js';
installBrowserGlobals();

/* A DOM stub — enough for the UI modules to be imported and for the component
   helpers to build nodes. They are not rendered; this proves the module graph
   is sound and that the shared helpers produce real elements. */
function installDomStub() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag || '').toUpperCase();
      this.childNodes = []; this.attributes = {}; this.style = {}; this.dataset = {};
      this.className = ''; this.listeners = {};
    }
    appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i > -1) this.childNodes.splice(i, 1); return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    insertAdjacentElement(_, el) { return this.appendChild(el); }
    focus() {} scrollIntoView() {} click() {}
    get firstChild() { return this.childNodes[0] || null; }
    get textContent() { return this.childNodes.map(c => c.textContent || c.text || '').join(''); }
    set textContent(v) { this.childNodes = [{ text: String(v), textContent: String(v) }]; }
    set innerHTML(v) { this._html = v; }
    get innerHTML() { return this._html || ''; }
  }
  globalThis.Node = Node;
  globalThis.document = {
    createElement: t => new Node(t),
    createElementNS: (_, t) => new Node(t),
    createTextNode: t => ({ text: String(t), textContent: String(t) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    body: new Node('body'),
    documentElement: new Node('html'),
    readyState: 'complete',
    images: []
  };
  globalThis.document.documentElement.setAttribute = function (k, v) { this.attributes[k] = v; };
  globalThis.window = {
    addEventListener: () => {}, removeEventListener: () => {},
    scrollTo: () => {}, matchMedia: () => ({ addEventListener: () => {} }),
    location: { reload: () => {} }
  };
  globalThis.CSS = { escape: s => String(s) };
  globalThis.FileReader = class { readAsText() {} readAsDataURL() {} };
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  globalThis.URL = Object.assign(globalThis.URL || {}, { createObjectURL: () => 'blob:', revokeObjectURL: () => {} });
  globalThis.Image = class { set src(v) { this._src = v; } };
  globalThis.setInterval = globalThis.setInterval || (() => 0);
}
installDomStub();

const { AppStore } = await import('../src/core/store.js');
const { seedDemoData } = await import('../src/core/demo.js');
const reservations = await import('../src/domain/reservations.js');
const folio = await import('../src/domain/folio.js');
const payments = await import('../src/domain/payments.js');
const units = await import('../src/domain/units.js');
const guests = await import('../src/domain/guests.js');
const dashboard = await import('../src/domain/dashboard.js');
const reportsApi = await import('../src/domain/reports.js');
const hk = await import('../src/domain/housekeeping.js');
const daily = await import('../src/domain/daily.js');
const search = await import('../src/domain/search.js');
const { today, addDays } = await import('../src/core/dates.js');
const { Database } = await import('../src/core/db.js');
const { COLLECTIONS } = await import('../src/core/schema.js');

/* ---------------------------------------------------------- demo seeding */

suite('Demo data seeds through the real domain services');

const store = await AppStore.boot();
store.signIn(store.users().find(u => u.role === 'admin'));
await store.updateProperty({ name: 'Swat Valley Guest House', type: 'guesthouse', city: 'Kalam', phone: '0300-1234567' });

let seedError = null;
try { await seedDemoData(store); } catch (err) { seedError = err; }
ok('seed completed without error', seedError === null, seedError && seedError.message);

eq('unit types created', store.db.live('unitTypes').length, 4);
eq('units created', units.listUnits(store).length, 16);
eq('guests created', guests.listGuests(store).length, 6);
ok('bookings created', store.db.all('reservations').length >= 6);
ok('a stay was completed and invoiced', store.db.all('invoices').length >= 1);
ok('payments recorded', store.db.all('payments').length >= 4);
ok('expenses recorded', store.db.all('expenses').length >= 3);
ok('housekeeping queue is not empty', hk.board(store).some(r => r.unit.hkStatus === 'dirty' || r.unit.hkStatus === 'cleaning'));

suite('The seeded data is internally consistent');

const inHouse = reservations.inHouse(store);
ok('three stays are in house', inHouse.length === 3, String(inHouse.length));
inHouse.forEach(r => {
  const unit = store.db.get('units', r.unitId);
  ok(`unit ${unit.code} reads as occupied`, unit.status === 'occupied');
});

// No two blocking bookings may share a unit-night anywhere in the dataset.
let overlaps = 0;
const blocking = store.db.all('reservations').filter(r => reservations.isBlocking(r));
for (let i = 0; i < blocking.length; i++) {
  for (let j = i + 1; j < blocking.length; j++) {
    const a = blocking[i], b = blocking[j];
    if (a.unitId === b.unitId && a.checkIn < b.checkOut && b.checkIn < a.checkOut) overlaps++;
  }
}
eq('no unit is double-booked anywhere in the dataset', overlaps, 0);

const withBalance = payments.outstanding(store);
ok('at least one stay carries a balance', withBalance.length >= 1);
ok('every balance is positive', withBalance.every(o => o.balance > 0));

const dash = dashboard.dashboardData(store, today());
ok('dashboard totals match the unit count', dash.totals.units === units.listUnits(store).length);
eq('occupied count matches in-house stays', dash.totals.occupied, inHouse.length);
ok('dashboard shows expected revenue', dash.expectedRevenue > 0);
ok('dashboard shows a collection figure', dash.collection > 0);

suite('Every report builds against seeded data');

for (const spec of reportsApi.REPORTS) {
  let r = null, err = null;
  try { r = reportsApi.buildReport(store, spec.id, addDays(today(), -7), addDays(today(), 7)); }
  catch (e) { err = e; }
  ok(`${spec.label} report builds`, err === null && r !== null, err && err.message);
  if (r) {
    ok(`${spec.label} declares columns`, Array.isArray(r.columns) && r.columns.length > 0);
    ok(`${spec.label} returns rows as an array`, Array.isArray(r.rows));
  }
}

suite('Search finds the seeded records');
ok('finds a guest', search.globalSearch(store, 'Bilal').some(r => r.type === 'guest'));
ok('finds a unit by name', search.globalSearch(store, 'Cottage').some(r => r.type === 'unit'));
ok('finds a booking', search.globalSearch(store, store.db.all('reservations')[0].code).some(r => r.type === 'reservation'));

/* ------------------------------------------------------ UI module graph */

suite('Every UI module loads and exports what the shell expects');

const uiModules = [
  ['dom', '../src/ui/dom.js'], ['feedback', '../src/ui/feedback.js'],
  ['components', '../src/ui/components.js'], ['forms', '../src/ui/forms.js'],
  ['print-actions', '../src/ui/print-actions.js'], ['app', '../src/ui/app.js']
];
const loaded = {};
for (const [name, path] of uiModules) {
  let mod = null, err = null;
  try { mod = await import(path); } catch (e) { err = e; }
  ok(`${name} loads`, err === null, err && err.message);
  if (mod) loaded[name] = mod;
}

const screenIds = ['dashboard', 'units', 'calendar', 'reservations', 'checkin', 'inhouse',
  'checkout', 'guests', 'register', 'payments', 'restaurant', 'inventory', 'housekeeping', 'expenses',
  'reports', 'closing', 'settings'];
const screenModules = {};
for (const id of screenIds) {
  let mod = null, err = null;
  try { mod = await import(`../src/ui/screens/${id}.js`); } catch (e) { err = e; }
  ok(`screen "${id}" loads`, err === null, err && err.message);
  if (mod) {
    ok(`screen "${id}" exports render()`, typeof mod.render === 'function');
    screenModules[id] = mod;
  }
}

// The shell's nav must line up with the screens that actually exist.
if (loaded.app) {
  const navIds = loaded.app.SCREENS.map(s => s.id);
  eq('every nav entry has a screen module', navIds.filter(id => !screenModules[id]), []);
  eq('every screen module is reachable from the nav', screenIds.filter(id => navIds.indexOf(id) === -1), []);
}

suite('Component helpers build real nodes');
if (loaded.components) {
  const c = loaded.components;
  const k = c.kpi({ label: 'Occupied', value: '5 / 18', sub: '28%' });
  ok('kpi builds an element', k && k.tagName === 'DIV');
  ok('kpi renders its label', String(k.textContent).indexOf('Occupied') > -1);

  const table = c.dataTable({
    columns: [{ key: 'a', label: 'Unit' }, { key: 'b', label: 'Rate', format: 'money' }],
    rows: [{ a: '204', b: 8500 }], currency: 'Rs'
  });
  ok('dataTable builds an element', table && table.tagName === 'DIV');
  ok('dataTable formats money cells', String(table.textContent).indexOf('8,500') > -1);

  const empty = c.dataTable({ columns: [{ key: 'a', label: 'Unit' }], rows: [] });
  ok('an empty table renders its empty state', String(empty.textContent).indexOf('No records') > -1);

  ok('badge builds', c.badge('Occupied', 'river').tagName === 'SPAN');
  ok('reservationBadge maps a status', String(c.reservationBadge('checked_in').textContent).indexOf('Checked in') > -1);
  ok('unitStatusColor returns a token', c.unitStatusColor('occupied').indexOf('var(--') === 0);
}

/* -------------------------------------------------------- reload safety */

suite('Reload safety');
await store.db.flush();
const reopened = await Database.open(COLLECTIONS);
eq('units survive a reload', reopened.all('units').length, units.listUnits(store).length);
eq('bookings survive a reload', reopened.all('reservations').length, store.db.all('reservations').length);
eq('payments survive a reload', reopened.all('payments').length, store.db.all('payments').length);
eq('invoices survive a reload', reopened.all('invoices').length, store.db.all('invoices').length);

const invoice = store.db.all('invoices')[0];
const persisted = reopened.all('invoices').find(i => i.no === invoice.no);
eq('an invoice keeps its total across a reload', persisted.totalAtIssue, invoice.totalAtIssue);
eq('an invoice keeps its line snapshot', persisted.bill.lines.length, invoice.bill.lines.length);

process.exit(report() === 0 ? 0 : 1);
