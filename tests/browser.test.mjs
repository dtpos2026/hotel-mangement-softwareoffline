/**
 * Functional tests in a real browser.
 *
 * These drive the actual UI — clicking the buttons reception clicks — so they
 * cover what the Node tests cannot: IndexedDB, rendering, the print pipeline,
 * the RTL switch and the modal flows. Run with: node tests/browser.test.mjs
 * (needs a static server on the port below; npm run test:browser starts one).
 */

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8765';
let passed = 0, failed = 0;
const failures = [];
let suiteName = '';

const suite = n => { suiteName = n; console.log('\n\x1b[1m' + n + '\x1b[0m'); };
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; failures.push(suiteName + ' › ' + label + (detail ? ' (' + detail + ')' : ''));
         console.log('  \x1b[31m✗ ' + label + '\x1b[0m' + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|Failed to load resource/.test(m.text())) pageErrors.push(m.text()); });

const TEST_PASSWORD = 'kalam2026';

const toastText = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('.toast')).map(t => t.innerText).join('\n'));
const clearToasts = () => page.evaluate(() =>
  document.querySelectorAll('.toast').forEach(t => t.remove()));
const closeAnyModal = async () => {
  await page.evaluate(() => {
    const m = window.__hms && window.__hms.feedback && window.__hms.feedback.closeAllModals;
    if (m) m();
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    document.body.style.overflow = '';
  });
  await page.waitForTimeout(200);
};
const go = async (screen) => { await page.evaluate(s => window.__hms.app.go(s), screen); await page.waitForTimeout(350); };

/* ------------------------------------------------------------------- boot */

suite('Boot and storage');
await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

// The app now opens on a sign-in screen; get through it first.
suite('Sign-in gate');
ok('the sign-in screen is shown', await page.locator('text=Sign in to continue').count() > 0);
ok('the default credentials are hinted on a fresh install',
  await page.locator('text=First time here?').count() > 0);

await page.fill('[name="username"]', 'admin');
await page.fill('#password', 'wrong-one');
await page.click('#signin');
await page.waitForTimeout(700);
ok('a wrong password is refused', await page.locator('text=Wrong username or password').count() > 0);

await page.fill('[name="username"]', 'admin');
await page.fill('#password', '123');
await page.click('#signin');
await page.waitForTimeout(900);
ok('the default password forces a change', await page.locator('text=Choose a new password').count() > 0);

const pwFields = await page.locator('.card input[type=password]').all();
await pwFields[0].fill(TEST_PASSWORD);
await pwFields[1].fill(TEST_PASSWORD);
await page.click('#save');
await page.waitForTimeout(2000);
await clearToasts();

suite('Boot and storage');
ok('the app booted', await page.evaluate(() => typeof window.__hms === 'object'));
const storage = await page.evaluate(() => window.__hms.store.db.storageKind());
ok('IndexedDB is the storage engine in a browser', storage === 'indexeddb', storage);
ok('a first-run setup dialog is shown', await page.locator('.modal__title').count() > 0);

await page.locator('button', { hasText: 'Load sample data to explore' }).click();
await page.waitForTimeout(2600);
ok('sample data loaded', (await page.evaluate(() => window.__hms.store.db.all('units').length)) === 16);
ok('the shell renders after setup', await page.locator('.sidebar').count() === 1);
await clearToasts();

/* ------------------------------------------------- double-booking, in UI */

suite('Double-booking protection, through the booking form');
await go('reservations');
await page.locator('button', { hasText: 'New booking' }).first().click();
await page.waitForTimeout(400);
ok('the booking form opened', await page.locator('.modal__title').first().innerText() === 'New booking');

// Pick the guest already occupying 204 for the same nights.
await page.locator('.modal button', { hasText: 'Choose guest' }).click();
await page.waitForTimeout(300);
await page.locator('.modal button.btn--block').first().click();
await page.waitForTimeout(400);

const occupiedUnit = await page.evaluate(() => {
  const s = window.__hms.store;
  const r = s.db.all('reservations').find(x => x.status === 'checked_in');
  const u = s.db.get('units', r.unitId);
  return { code: u.code, checkIn: r.checkIn, checkOut: r.checkOut };
});

// Set the dates to overlap that stay, then confirm the unit is NOT offered.
await page.evaluate(({ checkIn, checkOut }) => {
  const set = (name, value) => {
    const el = document.querySelector(`.modal [name="${name}"]`);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set('checkIn', checkIn);
  set('checkOut', checkOut);
}, occupiedUnit);
await page.waitForTimeout(500);

const offered = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.modal .chips .chip')).map(c => c.innerText.trim().split('\n')[0]));
ok('an occupied unit is not offered for overlapping dates',
  !offered.some(c => c.startsWith(occupiedUnit.code)), `offered: ${offered.join(', ')}`);
ok('other units are still offered', offered.length > 0);

// Now force the clash through the domain, exactly as a stale form would.
const clash = await page.evaluate(async ({ code, checkIn, checkOut }) => {
  const s = window.__hms.store;
  const unit = s.db.live('units').find(u => u.code === code);
  const guest = s.db.live('guests')[0];
  const api = await import('/src/domain/reservations.js');
  try {
    await api.createReservation(s, {
      guestId: guest.id, unitId: unit.id, checkIn, checkOut, adults: 1
    });
    return { refused: false };
  } catch (err) {
    return { refused: true, code: err.code, message: err.message, conflicts: (err.conflicts || []).length };
  }
}, occupiedUnit);
ok('the domain refuses the overlapping booking', clash.refused);
ok('the refusal uses the required wording',
  clash.message === 'Room/Unit is unavailable for the selected dates.', clash.message);
ok('the refusal names the conflicting booking', clash.conflicts === 1);

await page.locator('.modal__close').first().click();
await page.waitForTimeout(300);
await clearToasts();

/* ------------------------------------------------------------- walk-in */

suite('Walk-in check-in, end to end');
await go('checkin');
const freeUnit = await page.evaluate(() => {
  const chips = Array.from(document.querySelectorAll('.chips .chip'));
  return chips.length ? chips[0].innerText.trim().split('\n')[0] : null;
});
ok('vacant units are offered', !!freeUnit);

await page.fill('#walkinGuest [name="fullName"]', 'Test Walkin Guest');
await page.fill('#walkinGuest [name="cnic"]', '3520212345671');
await page.fill('#walkinGuest [name="phone"]', '03009998877');
await page.locator('.chips .chip').first().click();
await page.waitForTimeout(250);
await page.fill('[name="wAdvance"]', '5000');
await page.waitForTimeout(350);

const billBefore = await page.evaluate(() =>
  document.querySelector('.rail .totals') ? document.querySelector('.rail .totals').innerText : '');
ok('the bill rail shows a grand total', /Grand total/.test(billBefore));
ok('the bill rail shows the balance after the advance', /Balance/.test(billBefore));

const before = await page.evaluate(() => window.__hms.store.db.all('reservations').length);
// The slip-printing variant, so the print pipeline is exercised too.
await page.locator('button', { hasText: 'Check in and print slip' }).click();
await page.waitForTimeout(1600);

const walkResult = await page.evaluate(() => {
  const s = window.__hms.store;
  const r = s.db.all('reservations').slice(-1)[0];
  const g = s.db.get('guests', r.guestId);
  const u = s.db.get('units', r.unitId);
  return { count: s.db.all('reservations').length, status: r.status, guest: g.fullName,
           cnic: g.cnic, unitStatus: u.status,
           payments: s.db.where('payments', 'reservationId', r.id).length };
});
ok('a booking was created', walkResult.count === before + 1);
ok('the guest was checked in', walkResult.status === 'checked_in');
ok('the guest profile was created', walkResult.guest === 'Test Walkin Guest');
ok('the CNIC was formatted on save', walkResult.cnic === '35202-1234567-1', walkResult.cnic);
ok('the unit reads as occupied', walkResult.unitStatus === 'occupied');
ok('the advance was receipted', walkResult.payments === 1);

// The check-in slip preview opens automatically.
await page.waitForTimeout(600);
ok('the check-in slip preview opened', await page.locator('.modal__title').count() > 0);

/* ------------------------------------------------------- 80mm printing */

suite('80mm receipt preview');
const receipt = await page.evaluate(() => {
  const frame = document.querySelector('.modal iframe');
  if (!frame) return null;
  const doc = frame.contentDocument;
  return {
    width: frame.style.width,
    page: (doc.querySelector('style') || {}).textContent || '',
    text: doc.body ? doc.body.innerText : ''
  };
});
ok('a preview frame is rendered', receipt !== null);
if (!receipt) {
  ok('the 80mm preview could be inspected', false, 'no iframe in the modal');
} else {
  ok('the preview is 80mm wide', receipt.width === '80mm', receipt.width);
  ok('the page size is declared as 80mm', /@page \{ size: 80mm auto/.test(receipt.page));
  ok('the receipt names the property', /Kalam Continental/.test(receipt.text));
  ok('the receipt shows the guest', /Test Walkin Guest/.test(receipt.text));
  ok('the receipt shows a balance line', /BALANCE/.test(receipt.text));
}

// Compact mode must be visibly shorter, in the live DOM.
const normalHeight = await page.evaluate(() => document.querySelector('.modal iframe').contentDocument.body.scrollHeight);
await page.locator('.modal button', { hasText: 'Compact' }).click();
await page.waitForTimeout(500);
const compact = await page.evaluate(() => {
  const doc = document.querySelector('.modal iframe').contentDocument;
  return { height: doc.body.scrollHeight, text: doc.body.innerText };
});
const saved = 1 - compact.height / normalHeight;
ok('compact mode is 25–50% shorter on screen', saved > 0.25 && saved < 0.5,
  `${normalHeight}px -> ${compact.height}px (${(saved * 100).toFixed(0)}%)`);
ok('compact still names the property', /Kalam Continental/.test(compact.text));
ok('compact still shows the balance', /BALANCE/.test(compact.text));

await page.locator('.modal button', { hasText: 'Close' }).click();
await page.waitForTimeout(300);
await clearToasts();

/* ------------------------------------------------------------ check-out */

suite('Check-out with a balance');

// Leave no modal behind: the preview above is closed by its own button, but a
// stray one would swallow the clicks below and report a baffling title.
await closeAnyModal();
await go('checkout');
await page.waitForTimeout(400);

// Pick a stay that genuinely owes money. Taking the first one instead looked
// equivalent and was not: the sample data is seeded relative to today, so on
// some dates the first stay is paid ahead and there is no balance to warn
// about at all.
const target = await page.evaluate(async () => {
  const s = window.__hms.store;
  const { billFor } = await import('/src/domain/folio.js');
  const owing = s.db.all('reservations')
    .filter(r => r.status === 'checked_in')
    .find(r => billFor(s, r).balance > 0);
  return owing ? owing.id : null;
});
ok('a checked-in stay with money outstanding exists to check out', target !== null);
await page.evaluate(id => window.__hms.app.go('checkout', { reservationId: id }), target);
await page.waitForTimeout(600);

// Collect nothing, so a balance remains — must ask for confirmation.
await page.fill('[name="payNow"]', '0');
await page.waitForTimeout(400);
const warned = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.alert--due')).map(a => a.innerText).join('\n'));
ok('an outstanding balance is called out before check-out', /Checkout balance pending/.test(warned), warned.slice(0, 80));

await page.locator('button', { hasText: 'Complete check-out' }).click();
await page.waitForTimeout(600);
const confirmTitle = await page.evaluate(() => {
  const t = document.querySelectorAll('.modal__title');
  return t.length ? t[t.length - 1].innerText : '';
});
ok('check-out with a balance asks for confirmation',
  /Close this stay with money outstanding/.test(confirmTitle), confirmTitle);

await page.locator('.modal button', { hasText: 'Check out with balance' }).click();
await page.waitForTimeout(1400);

const closed = await page.evaluate(id => {
  const s = window.__hms.store;
  const r = s.db.get('reservations', id);
  const inv = s.db.all('invoices').find(i => i.reservationId === id);
  const u = s.db.get('units', r.unitId);
  return { status: r.status, invoiceNo: r.invoiceNo, hasInvoice: !!inv,
           balanceAtIssue: inv ? inv.balanceAtIssue : null,
           unitStatus: u.status, hkStatus: u.hkStatus };
}, target);
ok('the stay is closed', closed.status === 'checked_out');
ok('an invoice number was issued', /^INV-\d{4}-\d{4}$/.test(closed.invoiceNo || ''), closed.invoiceNo);
ok('the invoice recorded the outstanding balance', closed.balanceAtIssue > 0);
ok('the unit went to cleaning', closed.unitStatus === 'cleaning');
ok('the unit was marked dirty', closed.hkStatus === 'dirty');

/* ------------------------------------------- historical invoice immunity */

suite('A historical invoice does not move when prices change');
const frozen = await page.evaluate(async (id) => {
  const s = window.__hms.store;
  const r = s.db.get('reservations', id);
  const folio = await import('/src/domain/folio.js');
  const unitsApi = await import('/src/domain/units.js');
  const before = folio.billFor(s, r).total;
  const unit = s.db.get('units', r.unitId);
  await unitsApi.saveUnit(s, Object.assign({}, unit, { baseRate: unit.baseRate * 3 }));
  const after = folio.billFor(s, s.db.get('reservations', id)).total;
  return { before, after, frozen: folio.billFor(s, s.db.get('reservations', id)).frozen };
}, target);
ok('the invoice total is unchanged after tripling the unit rate',
  frozen.before === frozen.after, `${frozen.before} -> ${frozen.after}`);
ok('the bill is served from the frozen invoice', frozen.frozen === true);

await page.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach(m => m.remove()));
await clearToasts();

/* ------------------------------------------------------------ A4 report */

suite('A4 register printing');
await go('register');
await page.locator('button', { hasText: 'Print register (A4)' }).click();
await page.waitForTimeout(900);
const a4 = await page.evaluate(() => {
  const frame = document.querySelector('.modal iframe');
  const doc = frame.contentDocument;
  return {
    width: frame.style.width,
    css: (doc.querySelector('style') || {}).textContent || '',
    text: doc.body ? doc.body.innerText : '',
    sheets: doc.querySelectorAll('.sheet').length
  };
});
ok('the A4 preview is 210mm wide', a4.width === '210mm', a4.width);
ok('the register prints landscape', /@page \{ size: A4 landscape/.test(a4.css));
ok('the masthead carries the property name', /Kalam Continental/.test(a4.text));
ok('the sheet carries a page number', /Page 1 of \d+/.test(a4.text));
ok('the Urdu title is printed', /روزنامچہ/.test(a4.text));
ok('at least one sheet was produced', a4.sheets >= 1);
await page.locator('.modal button', { hasText: 'Close' }).click();
await page.waitForTimeout(300);

/* ------------------------------------------------------------- language */

suite('Urdu interface');
await page.locator('.topbar button', { hasText: 'اردو' }).click();
await page.waitForTimeout(700);
const rtl = await page.evaluate(() => ({
  dir: document.documentElement.getAttribute('dir'),
  lang: document.documentElement.getAttribute('lang'),
  toggle: document.querySelector('.topbar .btn--sm').innerText,
  navDirection: getComputedStyle(document.querySelector('.sidebar')).direction,
  // Every kind of figure must stay left-to-right inside an RTL page.
  figureDirections: ['.kpi__value', '.mono', '.topbar__clock', '.unit-card__code', '.table td.num']
    .map(sel => {
      const el = document.querySelector(sel);
      return { sel, dir: el ? getComputedStyle(el).direction : 'absent' };
    })
}));
ok('the page switches to RTL', rtl.dir === 'rtl', rtl.dir);
ok('the language attribute switches', rtl.lang === 'ur');
ok('the toggle now offers English', rtl.toggle === 'English');
const misordered = rtl.figureDirections.filter(f => f.dir === 'rtl');
ok('every kind of figure stays left-to-right inside the RTL page',
  misordered.length === 0, misordered.map(f => f.sel).join(', '));
ok('the figure classes were actually present to check',
  rtl.figureDirections.filter(f => f.dir === 'ltr').length >= 2,
  JSON.stringify(rtl.figureDirections));
await page.screenshot({ path: '/tmp/claude-0/-home-user-hotel-mangement-softwareoffline/7ae72d56-63f2-55de-83bf-3e6f2b51d3f2/scratchpad/shots/urdu.png' });

await page.locator('.topbar button', { hasText: 'English' }).click();
await page.waitForTimeout(600);
ok('switching back restores LTR', (await page.evaluate(() => document.documentElement.getAttribute('dir'))) === 'ltr');
await clearToasts();

/* --------------------------------------------------------------- search */

suite('Global search');
await page.fill('#globalSearch', 'Walkin');
await page.waitForTimeout(450);
const results = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.search__result')).map(r => r.innerText.replace(/\n/g, ' · ')));
ok('search finds the walk-in guest', results.some(r => /Test Walkin Guest/.test(r)), results.join(' | ').slice(0, 120));
await page.fill('#globalSearch', '204');
await page.waitForTimeout(450);
const unitResults = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.search__result')).map(r => r.innerText));
ok('search finds a unit by number', unitResults.some(r => /204/.test(r)));
await page.evaluate(() => window.__hms.app.closeSearch());

/* ------------------------------------------------- persistence + backup */

suite('Reload and backup');
const beforeReload = await page.evaluate(() => {
  const s = window.__hms.store;
  return { reservations: s.db.all('reservations').length, guests: s.db.live('guests').length,
           invoices: s.db.all('invoices').length, payments: s.db.all('payments').length };
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
ok('a reload returns to the sign-in screen', await page.locator('text=Sign in to continue').count() > 0);
await page.fill('[name="username"]', 'admin');
await page.fill('#password', TEST_PASSWORD);
await page.click('#signin');
await page.waitForTimeout(2000);
await clearToasts();

const afterReload = await page.evaluate(() => {
  const s = window.__hms.store;
  return { reservations: s.db.all('reservations').length, guests: s.db.live('guests').length,
           invoices: s.db.all('invoices').length, payments: s.db.all('payments').length,
           storage: s.db.storageKind() };
});
ok('bookings survive a reload', afterReload.reservations === beforeReload.reservations,
  `${beforeReload.reservations} -> ${afterReload.reservations}`);
ok('guests survive a reload', afterReload.guests === beforeReload.guests);
ok('invoices survive a reload', afterReload.invoices === beforeReload.invoices);
ok('payments survive a reload', afterReload.payments === beforeReload.payments);
ok('still on IndexedDB after the reload', afterReload.storage === 'indexeddb');
ok('no setup dialog on a second run', await page.locator('.modal__title').count() === 0);

const roundTrip = await page.evaluate(async () => {
  const s = window.__hms.store;
  const backup = await import('/src/core/backup.js');
  const snap = backup.buildBackup(s);
  const valid = backup.validateBackup(snap);

  // Add a record, then restore and confirm it is gone.
  const guestsApi = await import('/src/domain/guests.js');
  const extra = await guestsApi.saveGuest(s, { fullName: 'Should Disappear', cnic: '99999-9999999-9', phone: '03001112222' });
  const grew = s.db.live('guests').length;
  await backup.restoreBackup(s, snap);
  return {
    validated: valid.ok,
    errors: valid.errors,
    grew,
    afterRestore: s.db.live('guests').length,
    extraGone: !s.db.get('guests', extra.id)
  };
});
ok('a backup of live data validates', roundTrip.validated, (roundTrip.errors || []).join('; '));
ok('restore rolls the dataset back', roundTrip.afterRestore === roundTrip.grew - 1);
ok('the record added after the backup is gone', roundTrip.extraGone);

const badRestore = await page.evaluate(async () => {
  const s = window.__hms.store;
  const backup = await import('/src/core/backup.js');
  const before = s.db.live('guests').length;
  let message = '';
  try { await backup.restoreBackup(s, { format: 'hms-offline-backup', data: { units: 'not-a-list' } }); }
  catch (err) { message = err.message; }
  return { message, before, after: s.db.live('guests').length };
});
ok('a corrupt backup is refused', /Restore failed/.test(badRestore.message), badRestore.message);
ok('the existing data is untouched after a failed restore', badRestore.before === badRestore.after);

/* ------------------------------------------------------------ permissions */

/* ------------------------------------------------- the receipt design picker */

suite('Choosing a receipt design');

await go('settings');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Receipt & printer');
  if (b) b.click();
});
await page.waitForTimeout(900);

ok('every design is offered as a card', await page.locator('.design-card').count() === 4);
ok('one design is marked as the current one', await page.locator('.design-card.is-active').count() === 1);
ok('the current design is the saved one',
  (await page.locator('.design-card.is-active .design-card__name').innerText()) === 'Classic');
ok('a real receipt is previewed beside them', await page.locator('.receipt-preview__frame').count() === 1);

const previewHas = (needle) => page.evaluate(n => {
  const f = document.querySelector('.receipt-preview__frame');
  return (f.contentDocument.body.innerHTML || '').includes(n);
}, needle);

ok('the preview shows the real property name', await previewHas('Kalam Continental'));
ok('the preview is the classic design to begin with', !(await previewHas('class="band"')));

await page.locator('.design-card', { hasText: 'Banded' }).click();
await page.waitForTimeout(500);
ok('choosing a design moves the marker',
  (await page.locator('.design-card.is-active .design-card__name').innerText()) === 'Banded');
ok('the preview redraws in the chosen design', await previewHas('class="band"'));
ok('the preview keeps the real property name', await previewHas('Kalam Continental'));

ok('nothing is saved until the button is pressed',
  (await page.evaluate(() => window.__hms.store.setting('printer').template)) === 'classic');

// Compact is a separate control, and the preview has to follow it too.
await page.locator('#modeBox button', { hasText: 'Compact' }).click();
await page.waitForTimeout(500);
ok('switching to compact redraws the preview as well', await previewHas('class="band"'));

await page.locator('#modeBox button', { hasText: 'Normal' }).click();
await page.waitForTimeout(400);

await page.locator('button', { hasText: 'Save printer settings' }).click();
await page.waitForTimeout(1200);
ok('saving stores the chosen design',
  (await page.evaluate(() => window.__hms.store.setting('printer').template)) === 'banded');
ok('saving leaves the paper geometry alone',
  (await page.evaluate(() => window.__hms.store.setting('printer').widthMm)) === 80);
await clearToasts();

// And the design has to reach a receipt that is actually printed.
const printed = await page.evaluate(async () => {
  const r80 = await import('/src/print/receipt80.js');
  return r80.sampleReceipt(window.__hms.store);
});
ok('a printed receipt uses the saved design', printed.includes('class="band"'));
ok('...and still carries the address', printed.includes('Kalam'));

await page.evaluate(() => window.__hms.store.updateSetting('printer',
  Object.assign({}, window.__hms.store.setting('printer'), { template: 'classic' })));
await page.waitForTimeout(400);

/* ------------------------------------------------------ stock & purchasing */

suite('Stock: the module obeys its switch');
// The sample data turns stock on, so the gate is tested by closing it.
ok('Stock is in the nav while the module is on',
  (await page.evaluate(() => window.__hms.app.visibleScreens().map(s => s.id))).indexOf('inventory') > -1);

await page.evaluate(() => window.__hms.store.updateSetting('inventory',
  Object.assign({}, window.__hms.store.setting('inventory'), { enabled: false })));
await page.waitForTimeout(400);
await page.evaluate(() => window.__hms.app.render());
await page.waitForTimeout(400);
ok('switching it off takes Stock out of the nav',
  (await page.evaluate(() => window.__hms.app.visibleScreens().map(s => s.id))).indexOf('inventory') === -1);
ok('...and takes its reports off the Reports screen',
  (await page.evaluate(async () => {
    const r = await import('/src/domain/reports.js');
    return r.visibleReports(window.__hms.store).map(x => x.id);
  })).indexOf('stock') === -1);

await page.evaluate(() => window.__hms.store.updateSetting('inventory',
  Object.assign({}, window.__hms.store.setting('inventory'), { enabled: true })));
await page.waitForTimeout(400);
await page.evaluate(() => window.__hms.app.render());
await page.waitForTimeout(400);
ok('switching it back on restores both',
  (await page.evaluate(() => window.__hms.app.visibleScreens().map(s => s.id))).indexOf('inventory') > -1);

await go('inventory');
const tabTo = async (label) => {
  await page.locator('.btn-group button', { hasText: label }).click();
  await page.waitForTimeout(400);
};
const actionBtn = (label) => page.locator('.page__actions button', { hasText: label }).first();
const stockState = () => page.evaluate(async () => {
  const inv = await import('/src/domain/inventory.js');
  const s = window.__hms.store;
  return {
    items: inv.listItems(s).length,
    suppliers: inv.listSuppliers(s).length,
    purchases: inv.listPurchases(s).length,
    owed: inv.summary(s).suppliersOwed,
    value: inv.summary(s).stockValue
  };
});

suite('Stock: the sample data fills the module');
const seeded = await stockState();
ok('items are stocked', seeded.items === 12, String(seeded.items));
ok('suppliers are set up', seeded.suppliers === 3, String(seeded.suppliers));
ok('deliveries are recorded', seeded.purchases === 3, String(seeded.purchases));
ok('a supplier is owed something, so the screen is not all zeros', seeded.owed > 0);
ok('the shelves are worth something', seeded.value > 0);
ok('the low-stock warning is showing', await page.locator('.alert--warn').count() > 0);
ok('the nav carries a badge for what needs ordering',
  (await page.evaluate(() => window.__hms.app.navCounts().inventory)) > 0);

suite('Stock: adding a supplier and an item');
await tabTo('Suppliers');
await actionBtn('Add supplier').click();
await page.waitForTimeout(400);
await page.fill('.modal [name="name"]', 'Bahrain Poultry');
await page.fill('.modal [name="phone"]', '0300-1234567');
await page.locator('.modal__foot button', { hasText: 'Add supplier' }).click();
await page.waitForTimeout(900);
await clearToasts();
ok('the supplier was added to the ones already there',
  (await stockState()).suppliers === seeded.suppliers + 1);

await tabTo('On hand');
await actionBtn('Add item').click();
await page.waitForTimeout(400);
await page.fill('.modal [name="name"]', 'Fresh eggs');
await page.selectOption('.modal [name="unit"]', 'dozen');
await page.fill('.modal [name="reorderLevel"]', '10');
await page.locator('.modal__foot button', { hasText: 'Add item' }).click();
await page.waitForTimeout(900);
await clearToasts();
ok('the item was added', (await stockState()).items === seeded.items + 1);
ok('a brand new item has nothing on hand',
  (await page.evaluate(async () => {
    const inv = await import('/src/domain/inventory.js');
    const s = window.__hms.store;
    return inv.onHand(s, inv.listItems(s).find(i => i.name === 'Fresh eggs').id);
  })) === 0);

suite('Stock: recording a purchase');
await tabTo('Purchases');
await actionBtn('Record purchase').click();
await page.waitForTimeout(500);

await page.locator('.po-line select').nth(0).selectOption({ label: 'Fresh eggs (dz)' });
await page.locator('.po-line__qty').nth(0).fill('50');
await page.locator('.po-line__cost').nth(0).fill('300');
await page.locator('.modal button', { hasText: 'Add another item' }).click();
await page.waitForTimeout(300);
await page.locator('.po-line select').nth(1).selectOption({ label: 'Cooking oil (L)' });
await page.locator('.po-line__qty').nth(1).fill('20');
await page.locator('.po-line__cost').nth(1).fill('600');
await page.waitForTimeout(300);

const lineAmounts = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.po-line__amount')).map(e => e.textContent.trim()));
// This is the bug a screenshot caught: a line total left at zero while the
// subtotal was right, because the row only redrew when a line was added.
ok('every line shows its own amount while it is being typed',
  lineAmounts.join(' | ') === 'Rs 15,000 | Rs 12,000', lineAmounts.join(' | '));
ok('the running total adds the lines up',
  (await page.locator('.modal .totals').innerText()).indexOf('Rs 27,000') > -1);

await page.fill('.modal [name="paid"]', '10000');
await page.waitForTimeout(300);
ok('what will still be owed is shown before saving',
  (await page.locator('.modal .totals').innerText()).indexOf('Rs 17,000') > -1);

await page.locator('.modal__foot button', { hasText: 'Record purchase' }).click();
await page.waitForTimeout(1400);
ok('the purchase is confirmed by number', (await toastText()).indexOf('PO-') > -1);
await clearToasts();

const afterBuy = await stockState();
ok('the eggs reached the shelf',
  (await page.evaluate(async () => {
    const inv = await import('/src/domain/inventory.js');
    const s = window.__hms.store;
    return inv.onHand(s, inv.listItems(s).find(i => i.name === 'Fresh eggs').id);
  })) === 50);
ok('the supplier account followed from the same form',
  afterBuy.owed === seeded.owed + 17000, afterBuy.owed + ' vs ' + seeded.owed);
ok('the shelves are worth more than before', afterBuy.value > seeded.value);

suite('Stock: the item rail and a movement');
await tabTo('On hand');
await page.locator('.table tbody tr', { hasText: 'Fresh eggs' }).click();
await page.waitForTimeout(500);
ok('the rail opens on the chosen item', await page.locator('.rail').count() === 1);
ok('it shows the movement that put the stock there', await page.locator('.move').count() === 1);
ok('the movement is marked as coming in',
  (await page.locator('.move').first().getAttribute('data-dir')) === 'in');

await page.locator('.rail button', { hasText: 'Record movement' }).click();
await page.waitForTimeout(500);
await page.fill('.modal [name="qty"]', '42');
await page.locator('.modal__foot button', { hasText: 'Record' }).click();
await page.waitForTimeout(1200);
await clearToasts();
ok('issuing stock reduces what is on hand',
  (await page.evaluate(async () => {
    const inv = await import('/src/domain/inventory.js');
    const s = window.__hms.store;
    return inv.onHand(s, inv.listItems(s).find(i => i.name === 'Fresh eggs').id);
  })) === 8);

suite('Stock: more cannot go out than exists');
await actionBtn('Record movement').click();
await page.waitForTimeout(500);
await page.selectOption('.modal [name="itemId"]', { label: 'Fresh eggs (dz)' });
await page.fill('.modal [name="qty"]', '9999');
await page.locator('.modal__foot button', { hasText: 'Record' }).click();
await page.waitForTimeout(900);
ok('the domain refuses it, in plain words', (await toastText()).toLowerCase().indexOf('in stock') > -1);

// That refusal is reported through the app's error handler, so it also lands
// in the console. It is expected here and nowhere else, so it is taken out of
// the collected errors by its exact text rather than by loosening the filter.
const expectedRefusal = pageErrors.findIndex(e => /Only .* of Fresh eggs are in stock/.test(e));
ok('the refusal was logged once, and is accounted for', expectedRefusal > -1, pageErrors.join(' | '));
if (expectedRefusal > -1) pageErrors.splice(expectedRefusal, 1);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await clearToasts();

suite('Stock: a purchase can be opened, and reversal is refused once used');
await tabTo('Purchases');
await page.locator('.table tbody tr').first().click();
await page.waitForTimeout(600);
ok('the bill lists what was delivered', await page.locator('.modal .table tbody tr').count() === 2);
ok('it shows what is still owed', (await page.locator('.modal').innerText()).indexOf('Still owed') > -1);

// The eggs have been used, so this purchase must not be reversible.
await page.locator('.modal button', { hasText: 'Cancel this purchase' }).click();
await page.waitForTimeout(500);
await page.locator('.modal__foot button', { hasText: 'Confirm' }).last().click();
await page.waitForTimeout(1000);
ok('a purchase whose stock has been used cannot be cancelled',
  (await toastText()).toLowerCase().indexOf('already been used') > -1);
const expectedCancel = pageErrors.findIndex(e => /already been used/.test(e));
ok('that refusal was logged once too', expectedCancel > -1, pageErrors.join(' | '));
if (expectedCancel > -1) pageErrors.splice(expectedCancel, 1);
await clearToasts();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

suite('Stock: the reports are on the Reports screen');
await go('reports');
await page.waitForTimeout(500);
const chipNames = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.chip')).map(c => c.textContent.trim()));
for (const name of ['Stock on hand', 'Purchases', 'Supplier balances', 'Stock consumed']) {
  ok(`"${name}" is offered as a report`, chipNames.indexOf(name) > -1, chipNames.join(', '));
}
for (const name of ['Stock on hand', 'Supplier balances', 'Stock consumed']) {
  await page.locator('.chip', { hasText: name }).first().click();
  await page.waitForTimeout(600);
  ok(`"${name}" renders rows`, await page.locator('.table tbody tr').count() > 0);
  ok(`"${name}" titles its card`,
    (await page.locator('.card__title').last().innerText()) === name);
}

suite('Role permissions in the UI');
const asReception = await page.evaluate(async () => {
  const s = window.__hms.store;
  const { newId } = await import('/src/core/ids.js');
  const user = { id: newId('u'), name: 'Test Reception', username: 'reception',
                 role: 'receptionist', active: true, passwordHash: '', pinHash: '', salt: '',
                 mustChangePassword: false, createdAt: new Date().toISOString(), archivedAt: null };
  await s.write('user.create', tx => tx.put('users', user));
  s.signIn(user);
  window.__hms.app.render();
  return {
    navIds: window.__hms.app.visibleScreens().map(x => x.id),
    canVoid: s.session.can('payment.void'),
    canSettings: s.session.can('settings.manage'),
    canPay: s.session.can('payment.create')
  };
});
ok('reception may take payments', asReception.canPay);
ok('reception may not void payments', !asReception.canVoid);
ok('Settings is hidden from reception', asReception.navIds.indexOf('settings') === -1, asReception.navIds.join(','));
ok('Day Close is hidden from reception', asReception.navIds.indexOf('closing') === -1);
ok('Check In is still available', asReception.navIds.indexOf('checkin') > -1);

const blocked = await page.evaluate(async () => {
  const s = window.__hms.store;
  try { await s.updateSetting('printer', { widthMm: 58 }); return { refused: false }; }
  catch (err) { return { refused: true, code: err.code }; }
});
ok('the domain refuses a settings change for reception', blocked.refused && blocked.code === 'PERMISSION_DENIED');

/* -------------------------------------------------------------- summary */

suite('Console health');
ok('no uncaught page errors during the whole run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

console.log('\n' + '─'.repeat(62));
if (failed === 0) console.log(`\x1b[32m\x1b[1mAll ${passed} browser checks passed.\x1b[0m`);
else { console.log(`\x1b[31m\x1b[1m${failed} failed\x1b[0m, ${passed} passed.\n`);
       failures.forEach(f => console.log('  \x1b[31m•\x1b[0m ' + f)); }
console.log('─'.repeat(62));

await browser.close();
process.exit(failed === 0 ? 0 : 1);
