/**
 * The shell: sidebar, top bar, router, global search, keyboard shortcuts.
 *
 * A screen is a function (ctx) -> DOM node. Navigation replaces the page
 * contents; a data change re-renders the current screen. There is no diffing
 * layer, which at this data scale is both simpler and quick enough.
 */

import { h, mount, clear, qs, debounce } from './dom.js';
import { toast, modal, closeAllModals } from './feedback.js';
import { t, setLanguage, getLanguage, dir } from '../core/i18n.js';
import { formatDateLong, formatTime, today, nowIso } from '../core/dates.js';
import { globalSearch } from '../domain/search.js';
import { saveAutoBackup, shouldAutoBackup } from '../core/backup.js';
import { arrivalsOn, departuresOn, inHouse } from '../domain/reservations.js';
import { countByStatus } from '../domain/units.js';
import { outstanding } from '../domain/payments.js';

export const SCREENS = [
  { id: 'dashboard',    label: 'Dashboard',    ur: 'ڈیش بورڈ',      perm: 'view.dashboard' },
  { id: 'units',        label: 'Units',        ur: 'کمرے',          perm: null },
  { id: 'calendar',     label: 'Calendar',     ur: 'کیلنڈر',        perm: null },
  { id: 'reservations', label: 'Bookings',     ur: 'بکنگ',          perm: null },
  { id: 'checkin',      label: 'Check In',     ur: 'آمد',           perm: 'stay.checkin' },
  { id: 'inhouse',      label: 'In House',     ur: 'موجود مہمان',   perm: null },
  { id: 'checkout',     label: 'Check Out',    ur: 'روانگی',        perm: 'stay.checkout' },
  { id: 'guests',       label: 'Guests',       ur: 'مہمان',         perm: null },
  { id: 'register',     label: 'Register',     ur: 'روزنامچہ',      perm: 'view.register' },
  { id: 'payments',     label: 'Payments',     ur: 'وصولیاں',       perm: null },
  { id: 'housekeeping', label: 'Housekeeping', ur: 'صفائی',         perm: 'housekeeping.update' },
  { id: 'expenses',     label: 'Expenses',     ur: 'اخراجات',       perm: 'expense.create' },
  { id: 'reports',      label: 'Reports',      ur: 'رپورٹس',        perm: 'view.reports' },
  { id: 'closing',      label: 'Day Close',    ur: 'یومیہ بندش',    perm: 'day.close' },
  { id: 'settings',     label: 'Settings',     ur: 'ترتیبات',       perm: 'settings.manage' }
];

export class App {
  constructor(store, root, screens) {
    this.store = store;
    this.root = root;
    this.screens = screens;          // id -> render(ctx)
    this.screen = 'dashboard';
    this.params = {};
    this.searchTerm = '';
    this.searchResults = [];
    this.searchIndex = -1;
    this._rerender = null;
  }

  /* --- navigation -------------------------------------------------------- */

  go(screen, params) {
    const spec = SCREENS.find(s => s.id === screen);
    if (spec && spec.perm && !this.store.session.can(spec.perm)) {
      toast('warn', t('msg.noPermission'), `"${spec.label}" is not available to your role.`);
      return;
    }
    closeAllModals();
    this.screen = screen;
    this.params = params || {};
    this.closeSearch();
    this.render();
    const main = qs('.main');
    if (main) main.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  /** Re-renders the current screen in place, keeping scroll position. */
  refresh() {
    const main = qs('.main');
    const y = main ? main.scrollTop : window.scrollY;
    this.render();
    if (main) main.scrollTop = y; else window.scrollTo(0, y);
  }

  visibleScreens() {
    return SCREENS.filter(s => !s.perm || this.store.session.can(s.perm));
  }

  /* --- badges on the nav ------------------------------------------------- */

  navCounts() {
    const store = this.store;
    const d = today();
    const status = countByStatus(store);
    return {
      checkin: arrivalsOn(store, d).filter(r => r.status === 'reserved').length,
      checkout: departuresOn(store, d).filter(r => r.status === 'checked_in').length,
      inhouse: inHouse(store).length,
      housekeeping: (status.cleaning || 0),
      payments: outstanding(store).length
    };
  }

  /* --- rendering --------------------------------------------------------- */

  render() {
    const store = this.store;
    document.documentElement.setAttribute('dir', dir());
    document.documentElement.setAttribute('lang', getLanguage());

    const counts = this.navCounts();
    const property = store.property;

    const app = h('div.app', { dataset: { nav: 'closed' } }, [
      this.sidebar(counts, property),
      h('main.main', [
        this.topbar(property),
        h('div.page', { id: 'page' })
      ])
    ]);

    mount(this.root, app);

    // The screen renders after the shell so a slow screen never blocks the
    // chrome, and so an error inside a screen leaves the app navigable.
    const page = qs('#page');
    try {
      const render = this.screens[this.screen];
      if (!render) throw new Error('Screen "' + this.screen + '" is not available.');
      mount(page, render({ store, app: this, params: this.params }));
    } catch (err) {
      console.error('[hms] screen failed:', err);
      mount(page, h('div.card', h('div.card__body', [
        h('div.alert.alert--due', [h('div', [
          h('div.alert__title', { text: 'This screen could not be shown' }),
          h('div', { text: err && err.message ? err.message : String(err), style: { marginTop: '4px' } })
        ])]),
        h('div', { style: { marginTop: '12px' } },
          h('button.btn', { type: 'button', text: 'Back to dashboard', onclick: () => this.go('dashboard') }))
      ])));
    }
  }

  sidebar(counts, property) {
    return h('aside.sidebar', [
      h('div.sidebar__brand', [
        h('div.sidebar__mark', property.logo
          ? h('img', { src: property.logo, alt: '' })
          : (property.name || 'HR').slice(0, 2).toUpperCase()),
        h('div', { style: { minWidth: 0 } }, [
          h('div.sidebar__name', { text: property.name || 'Hotel Register', title: property.name }),
          h('div.sidebar__meta', { text: 'v1.0 · offline' })
        ])
      ]),

      h('nav.sidebar__nav', this.visibleScreens().map(s => {
        const count = counts[s.id];
        return h('button.nav-item', {
          type: 'button',
          class: s.id === this.screen ? 'is-active' : null,
          onclick: () => this.go(s.id)
        }, [
          h('span', { text: s.label }),
          count ? h('span.nav-item__count', { text: String(count) })
                : h('span.nav-item__ur', { text: s.ur })
        ]);
      })),

      h('div.sidebar__keys', [
        h('span', { text: 'F2 check in · F4 check out' }),
        h('span', { text: 'F8 print register · Ctrl+K search' })
      ]),

      h('div.sidebar__by', [
        h('img', { src: 'assets/brand-digital-target.jpg', alt: '', width: 32, height: 32 }),
        h('div', { style: { minWidth: 0 } }, [
          h('div.sidebar__by-label', { text: 'Software by' }),
          h('div.sidebar__by-name', { text: 'Digital Target' })
        ])
      ])
    ]);
  }

  topbar(property) {
    const store = this.store;
    const session = store.session;
    const degraded = store.db.degraded;

    const searchInput = h('input.search__input', {
      type: 'search', id: 'globalSearch',
      placeholder: t('app.search'),
      value: this.searchTerm,
      autocomplete: 'off',
      oninput: debounce(e => this.runSearch(e.target.value), 140),
      onkeydown: e => this.onSearchKey(e),
      onfocus: () => { if (this.searchResults.length) this.renderSearchResults(); }
    });

    const clock = h('div.topbar__clock', { id: 'clock', text: `${formatDateLong(today())} · ${formatTime(nowIso())}` });

    return h('header.topbar', [
      h('div.topbar__property', [
        h('div.topbar__logo', property.logo
          ? h('img', { src: property.logo, alt: '' })
          : (property.name || 'HR').slice(0, 2).toUpperCase()),
        h('div', { style: { minWidth: 0 } }, [
          h('div.topbar__title', { text: property.name || 'Hotel Register' }),
          clock
        ])
      ]),

      h('div.search', [
        h('div.search__field', [
          searchInput,
          h('span.search__kbd', { text: 'Ctrl K' })
        ]),
        h('div', { id: 'searchResults' })
      ]),

      h('div.topbar__right', [
        h('span.pill-offline', { class: degraded ? 'is-degraded' : null,
          title: degraded
            ? 'IndexedDB is unavailable here, so data is stored in this browser’s local storage. Take backups regularly.'
            : 'All data is stored on this device. No internet is used.' },
          h('span', { text: degraded ? 'Offline — limited storage' : t('app.offline') })),

        h('button.btn.btn--sm', {
          type: 'button', text: t('app.language'), title: 'English / اردو',
          onclick: () => this.toggleLanguage()
        }),

        h('button.userchip', {
          type: 'button',
          style: { border: 0, background: 'transparent' },
          title: 'Switch user',
          onclick: () => this.showUserMenu()
        }, [
          h('div.userchip__avatar', { text: session.initials() }),
          h('div', { style: { textAlign: 'start' } }, [
            h('div.userchip__name', { text: session.name }),
            h('div.userchip__role', { text: session.role || 'signed out' })
          ])
        ])
      ])
    ]);
  }

  /* --- global search ----------------------------------------------------- */

  runSearch(term) {
    this.searchTerm = term;
    this.searchIndex = -1;
    this.searchResults = term && term.trim().length >= 2 ? globalSearch(this.store, term) : [];
    this.renderSearchResults();
  }

  renderSearchResults() {
    const holder = qs('#searchResults');
    if (!holder) return;
    if (!this.searchResults.length) {
      if (this.searchTerm && this.searchTerm.trim().length >= 2) {
        mount(holder, h('div.search__results',
          h('div', { style: { padding: '14px', fontSize: '13px', color: 'var(--muted)' },
                     text: `Nothing matches “${this.searchTerm}”.` })));
      } else clear(holder);
      return;
    }
    mount(holder, h('div.search__results', this.searchResults.map((r, i) =>
      h('button.search__result', {
        type: 'button',
        class: i === this.searchIndex ? 'is-active' : null,
        onclick: () => this.openResult(r)
      }, [
        h('div', { style: { minWidth: 0, flex: '1' } }, [
          h('div.search__result-title.truncate', { text: r.title }),
          h('div.search__result-sub.truncate', { text: r.subtitle })
        ]),
        h('span.badge.badge--muted', { text: r.badge })
      ]))));
  }

  onSearchKey(e) {
    if (e.key === 'Escape') { this.closeSearch(); e.target.blur(); return; }
    if (!this.searchResults.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.searchIndex = (this.searchIndex + 1) % this.searchResults.length;
      this.renderSearchResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.searchIndex = (this.searchIndex - 1 + this.searchResults.length) % this.searchResults.length;
      this.renderSearchResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.openResult(this.searchResults[Math.max(0, this.searchIndex)]);
    }
  }

  openResult(result) {
    if (!result) return;
    this.closeSearch();
    this.go(result.route.screen, result.route);
  }

  closeSearch() {
    this.searchTerm = '';
    this.searchResults = [];
    this.searchIndex = -1;
    const holder = qs('#searchResults');
    if (holder) clear(holder);
    const input = qs('#globalSearch');
    if (input) input.value = '';
  }

  focusSearch() {
    const input = qs('#globalSearch');
    if (input) { input.focus(); input.select(); }
  }

  /* --- language, users --------------------------------------------------- */

  async toggleLanguage() {
    const next = getLanguage() === 'ur' ? 'en' : 'ur';
    setLanguage(next);
    try { await this.store.updateSetting('app', { language: next }); }
    catch { /* a signed-out or restricted user still gets the switch locally */ }
    this.render();
  }

  showUserMenu() {
    const store = this.store;
    const users = store.users();
    const dialog = modal({
      title: 'Switch user',
      subtitle: 'Each user has their own role and permissions.',
      body: h('div.stack.stack--sm', users.length ? users.map(u => h('button.btn.btn--block', {
        type: 'button',
        style: { justifyContent: 'flex-start', gap: '10px' },
        class: u.id === store.session.id ? 'btn--primary' : null,
        onclick: () => { dialog.close(); this.signInAs(u); }
      }, [
        h('span.userchip__avatar', { text: (u.name || '?').slice(0, 2).toUpperCase(),
          style: { width: '24px', height: '24px', flex: '0 0 24px', fontSize: '10px' } }),
        h('span', { text: u.name }),
        h('span.push.text-xs', { text: u.role, style: { textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.7 } })
      ])) : [h('div.text-muted', { text: 'No users are configured. Open Settings to add one.' })]),
      footer: [
        store.session.can('user.manage')
          ? h('button.btn', { type: 'button', text: 'Manage users', onclick: () => { dialog.close(); this.go('settings', { tab: 'users' }); } })
          : null,
        h('button.btn.btn--primary', { type: 'button', text: 'Close', onclick: () => dialog.close() })
      ]
    });
  }

  async signInAs(user) {
    const pinned = user.pinHash && user.pinHash !== '';
    if (!pinned) { this.store.signIn(user); this.afterSignIn(user); return; }

    const { promptText } = await import('./feedback.js');
    const pin = await promptText({
      title: `Sign in as ${user.name}`,
      label: 'PIN',
      placeholder: '••••',
      requiredMessage: 'Enter the PIN for this user.',
      confirmLabel: 'Sign in'
    });
    if (pin === null) return;
    const valid = await this.store.verifyPin(user, pin);
    if (!valid) { toast('error', 'Incorrect PIN', 'That PIN does not match this user.'); return; }
    this.store.signIn(user);
    this.afterSignIn(user);
  }

  afterSignIn(user) {
    toast('ok', `Signed in as ${user.name}`, user.role);
    const spec = SCREENS.find(s => s.id === this.screen);
    if (spec && spec.perm && !this.store.session.can(spec.perm)) {
      const first = this.visibleScreens()[0];
      this.screen = first ? first.id : 'dashboard';
    }
    this.render();
  }

  /* --- lifecycle --------------------------------------------------------- */

  start() {
    this.render();

    // The clock is the only thing that ticks; repainting the whole shell every
    // second would fight with open menus and focused inputs.
    setInterval(() => {
      const el = qs('#clock');
      if (el) el.textContent = `${formatDateLong(today())} · ${formatTime(nowIso())}`;
    }, 10000);

    // Any committed write re-renders the current screen.
    this.store.subscribe(debounce(() => this.refresh(), 60));

    document.addEventListener('keydown', e => this.onGlobalKey(e));

    document.addEventListener('click', e => {
      const search = e.target.closest('.search');
      if (!search && this.searchResults.length) this.closeSearch();
    });

    window.addEventListener('beforeunload', () => { this.store.db.flush(); });

    this.maybeAutoBackup();
  }

  onGlobalKey(e) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); this.focusSearch(); return;
    }
    if (typing) return;

    if (e.key === 'F2')  { e.preventDefault(); this.go('checkin'); }
    else if (e.key === 'F4')  { e.preventDefault(); this.go('checkout'); }
    else if (e.key === 'F8')  { e.preventDefault(); this.go('register'); }
    else if (e.key === 'F9')  { e.preventDefault(); this.go('calendar'); }
    else if (e.key === '/')   { e.preventDefault(); this.focusSearch(); }
  }

  /** One automatic local backup per day, taken quietly in the background. */
  async maybeAutoBackup() {
    try {
      if (!shouldAutoBackup(this.store)) return;
      const made = saveAutoBackup(this.store);
      if (made) await this.store.updateSetting('app', { lastAutoBackupAt: nowIso() });
    } catch (err) {
      console.warn('[hms] auto-backup skipped:', err);
    }
  }
}
