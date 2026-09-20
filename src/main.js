/**
 * Entry point: boot storage, register the screens, start the shell.
 */

import { AppStore } from './core/store.js';
import { App } from './ui/app.js';
import * as host from './core/host.js';
import { activationGate } from './ui/screens/activation.js';
import { loginGate } from './ui/screens/login.js';
import { h, mount, qs } from './ui/dom.js';
import { toast, modal, ok as toastOk, fail } from './ui/feedback.js';
import { field, alert } from './ui/components.js';
import { PROPERTY_TYPES } from './core/schema.js';
import { seedDemoData } from './core/demo.js';

import * as dashboard from './ui/screens/dashboard.js';
import * as units from './ui/screens/units.js';
import * as calendar from './ui/screens/calendar.js';
import * as reservations from './ui/screens/reservations.js';
import * as checkin from './ui/screens/checkin.js';
import * as inhouse from './ui/screens/inhouse.js';
import * as checkout from './ui/screens/checkout.js';
import * as guests from './ui/screens/guests.js';
import * as register from './ui/screens/register.js';
import * as payments from './ui/screens/payments.js';
import * as housekeeping from './ui/screens/housekeeping.js';
import * as expenses from './ui/screens/expenses.js';
import * as reports from './ui/screens/reports.js';
import * as closing from './ui/screens/closing.js';
import * as settings from './ui/screens/settings.js';
import * as activation from './ui/screens/activation.js';

const SCREEN_MODULES = {
  dashboard, units, calendar, reservations, checkin, inhouse, checkout,
  guests, register, payments, housekeeping, expenses, reports, closing, settings,
  activation
};

function splash(message, detail) {
  return h('div', {
    style: {
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#F4F6F5', padding: '24px'
    }
  }, h('div', { style: { textAlign: 'center', maxWidth: '460px' } }, [
    h('div', {
      style: {
        width: '52px', height: '52px', margin: '0 auto 16px', borderRadius: '10px',
        background: '#3C096C', color: '#F2EBF8', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontFamily: "'IBM Plex Mono',monospace", fontWeight: '700', fontSize: '18px'
      }, text: 'HR'
    }),
    h('div', { style: { fontSize: '16px', fontWeight: '600', color: '#16202A' }, text: message }),
    detail ? h('div', { style: { fontSize: '13px', color: '#6B7280', marginTop: '8px', lineHeight: '1.55' }, text: detail }) : null
  ]));
}

async function boot() {
  const root = qs('#root');
  mount(root, splash('Opening your data…'));

  // The licence decides whether the app opens at all, so it is checked before
  // the database so an expired copy never even touches the data.
  const licence = await host.licenceStatus();
  host.setLicence(licence);

  if (!licence.ok) {
    activationGate(root, licence, () => window.location.reload());
    return;
  }

  let store;
  try {
    store = await AppStore.boot();
  } catch (err) {
    console.error('[hms] boot failed:', err);
    mount(root, splash('This device is not allowing local storage',
      'The application keeps everything on this computer, so it needs either IndexedDB or local storage to be available. ' +
      'Private/incognito windows and some locked-down browser profiles block both. Try a normal window, or a different browser.'));
    return;
  }

  // Sign-in gate. Nothing is rendered until a real user is signed in, so the
  // app never starts up as somebody.
  await new Promise(resolve => {
    loginGate(root, store, () => resolve());
  });

  const screens = {};
  for (const id of Object.keys(SCREEN_MODULES)) screens[id] = SCREEN_MODULES[id].render;

  const app = new App(store, root, screens);
  window.__hms = { store, app, licence };   // a hook for support, not used by the app
  app.start();

  wireNativeMenu(app);
  await nightlyDiskBackup(store);

  // A licence inside its last fortnight is worth mentioning once at startup,
  // long before it becomes an emergency at the front desk.
  if (licence.expiringSoon) {
    toast('warn', 'Licence expiring soon', licence.message, 12000);
  }

  if (store.db.all('units').length === 0) firstRun(store, app);
}

/** Native menu items map onto the same navigation the sidebar uses. */
function wireNativeMenu(app) {
  host.onMenu(action => {
    switch (action) {
      case 'search':    app.focusSearch(); break;
      case 'backup':    app.go('settings', { tab: 'backup' }); break;
      case 'restore':   app.go('settings', { tab: 'backup' }); break;
      case 'licence':   app.go('settings', { tab: 'licence' }); break;
      case 'testprint': app.go('settings', { tab: 'printing' }); break;
      default:          app.go(action); break;
    }
  });
}

/**
 * On the desktop, write one backup a day into Documents. The in-browser copy
 * is convenient; this is the one that survives a reinstall or a new computer.
 */
async function nightlyDiskBackup(store) {
  if (!host.isDesktop) return;
  try {
    const { shouldAutoBackup, buildBackup, backupFilename } = await import('./core/backup.js');
    if (!shouldAutoBackup(store)) return;
    const backup = buildBackup(store);
    const result = await host.autoBackupToDisk(backupFilename(store, 'auto'), JSON.stringify(backup));
    if (result.ok) await store.updateSetting('app', { lastAutoBackupAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[hms] disk backup skipped:', err);
  }
}

/* ------------------------------------------------------------- first run */

/** One short setup step, so the app is never a blank board on day one. */
function firstRun(store, app) {
  const form = h('div.stack', [
    h('div.form-grid.form-grid--2', [
      field({ label: 'Property name', name: 'name', required: true, autofocus: true,
        value: store.property.name || '', placeholder: 'Kalam Continental' }),
      field({ label: 'Property type', name: 'type', type: 'select', value: store.property.type || 'guesthouse',
        options: PROPERTY_TYPES.map(t => ({ value: t.id, label: t.label })),
        hint: 'Decides whether the app says Room, Cottage, Apartment…' }),
      field({ label: 'City', name: 'city', value: store.property.city || '', placeholder: 'Kalam' }),
      field({ label: 'Phone', name: 'phone', mono: true, value: store.property.phone || '', placeholder: '0300-1234567' })
    ]),
    alert('info', 'Everything stays on this computer',
      'There is no account, no cloud and no internet connection. Take a backup from Settings at the end of each day.')
  ]);

  const dialog = modal({
    title: 'Welcome — set up your property',
    subtitle: 'Two minutes now, then you can take bookings.',
    size: 'wide',
    dismissable: false,
    body: form,
    footer: [
      h('button.btn', { type: 'button', text: 'Load sample data to explore',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.classList.add('is-busy'); btn.disabled = true;
          try {
            const { formValues } = await import('./ui/dom.js');
            const v = formValues(form);
            if (v.name) await store.updateProperty(v);
            await seedDemoData(store);
            toastOk('Sample data loaded',
              'A small property with units, guests and bookings, so every screen has something in it. Erase it any time from Settings › About.');
            dialog.close();
            app.go('dashboard');
          } catch (err) { fail(err); btn.classList.remove('is-busy'); btn.disabled = false; }
        } }),
      h('button.btn.btn--primary', { type: 'button', text: 'Save and start',
        onclick: async (e) => {
          const btn = e.currentTarget;
          const { formValues } = await import('./ui/dom.js');
          const v = formValues(form);
          if (!String(v.name || '').trim()) { toast('warn', 'Property name is required'); return; }
          btn.classList.add('is-busy'); btn.disabled = true;
          try {
            await store.updateProperty(v);
            dialog.close();
            toastOk('Property saved', 'Next: add a unit type, then your rooms.');
            app.go('units');
          } catch (err) { fail(err); btn.classList.remove('is-busy'); btn.disabled = false; }
        } })
    ]
  });
}

boot().catch(err => {
  console.error('[hms] fatal:', err);
  const root = qs('#root');
  if (root) mount(root, splash('Something went wrong while starting', String(err && err.message || err)));
});
