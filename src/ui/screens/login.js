/**
 * Sign-in, and the forced password change that follows the first one.
 *
 * The software ships with admin / 123 so a property can get in on day one.
 * That is only safe because the account is flagged mustChangePassword, and
 * this screen will not let it past until a new password is set.
 */

import { h, mount, qs, busy } from '../dom.js';
import { card, alert } from '../components.js';
import { toast, ok as toastOk, fail } from '../feedback.js';
import { checkPassword, DEFAULT_USERNAME, DEFAULT_PASSWORD, roleLabel } from '../../core/auth.js';

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30000;

const state = { attempts: 0, lockedUntil: 0 };

/**
 * Shows the sign-in screen and resolves once a user is signed in and any
 * required password change is done.
 */
export function loginGate(root, store, onSignedIn) {
  const body = h('div', { style: { width: '100%', maxWidth: '400px' } });
  mount(root, h('div', {
    style: {
      minHeight: '100vh', background: 'var(--canvas)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 20px'
    }
  }, body));

  const property = store.property;

  function header() {
    return h('div', { style: { textAlign: 'center', marginBottom: '20px' } }, [
      h('div', {
        style: {
          width: '54px', height: '54px', margin: '0 auto 14px', borderRadius: '11px',
          background: 'var(--accent)', color: '#F2EBF8', display: 'flex',
          alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          fontFamily: 'var(--font-mono)', fontWeight: '700', fontSize: '18px'
        }
      }, property.logo
        ? h('img', { src: property.logo, style: { width: '100%', height: '100%', objectFit: 'cover' } })
        : (property.name || 'HR').slice(0, 2).toUpperCase()),
      h('h1', { style: { fontSize: '20px' }, text: property.name || 'Hotel Register' }),
      h('div.text-sm.text-muted', { style: { marginTop: '4px' }, text: 'Sign in to continue' })
    ]);
  }

  /* ------------------------------------------------------------- sign in */

  function drawLogin(message) {
    const users = store.users();
    const usingDefault = users.some(u => u.username === DEFAULT_USERNAME && u.mustChangePassword);

    const username = h('input.input', {
      name: 'username', autocomplete: 'username', autofocus: true,
      value: localStorage.getItem('hms:lastUser') || (usingDefault ? DEFAULT_USERNAME : ''),
      placeholder: 'admin',
      onkeydown: e => { if (e.key === 'Enter') qs('#password', body).focus(); }
    });
    const password = h('input.input#password', {
      name: 'password', type: 'password', autocomplete: 'current-password',
      onkeydown: e => { if (e.key === 'Enter') qs('#signin', body).click(); }
    });

    mount(body, [
      header(),
      card({}, h('div.stack', [
        message ? alert('due', 'Could not sign in', message) : null,

        usingDefault ? alert('info', 'First time here?',
          `Sign in with username "${DEFAULT_USERNAME}" and password "${DEFAULT_PASSWORD}". You will be asked to choose a new password straight away.`) : null,

        h('div.field', [h('label.field__label', { text: 'Username' }), username]),
        h('div.field', [h('label.field__label', { text: 'Password' }), password]),

        h('button.btn.btn--primary.btn--lg.btn--block#signin', {
          type: 'button', text: 'Sign in',
          onclick: e => busy(e.currentTarget, async () => {
            if (Date.now() < state.lockedUntil) {
              const wait = Math.ceil((state.lockedUntil - Date.now()) / 1000);
              toast('warn', 'Too many attempts', `Wait ${wait} seconds and try again.`);
              return;
            }

            const name = username.value.trim();
            const pass = password.value;
            if (!name || !pass) { toast('warn', 'Enter your username and password'); return; }

            const user = store.findUser(name);
            // The same message either way, so an unknown username cannot be
            // told apart from a wrong password.
            const okPass = user ? await store.verifyPassword(user, pass) : false;

            if (!okPass) {
              state.attempts += 1;
              if (state.attempts >= MAX_ATTEMPTS) {
                state.lockedUntil = Date.now() + LOCKOUT_MS;
                state.attempts = 0;
                drawLogin(`Too many failed attempts. Try again in ${LOCKOUT_MS / 1000} seconds.`);
                return;
              }
              drawLogin(`Wrong username or password. ${MAX_ATTEMPTS - state.attempts} attempt(s) left.`);
              return;
            }

            state.attempts = 0;
            localStorage.setItem('hms:lastUser', user.username || '');

            if (user.mustChangePassword) { drawChange(user); return; }

            store.signIn(user);
            toastOk(`Welcome, ${user.name}`, roleLabel(user.role));
            onSignedIn(user);
          })
        }),

        h('div.text-xs.text-muted', { style: { textAlign: 'center', lineHeight: '1.6' },
          text: 'Ask your manager if you have forgotten your password. An administrator can reset it in Settings.' })
      ]))
    ]);

    setTimeout(() => { (username.value ? password : username).focus(); }, 40);
  }

  /* --------------------------------------------------- forced change */

  function drawChange(user) {
    const next = h('input.input', { type: 'password', autocomplete: 'new-password', autofocus: true });
    const again = h('input.input', {
      type: 'password', autocomplete: 'new-password',
      onkeydown: e => { if (e.key === 'Enter') qs('#save', body).click(); }
    });

    mount(body, [
      header(),
      card({ title: 'Choose a new password' }, h('div.stack', [
        alert('warn', 'The default password must be changed',
          `This account is still using the password the software ships with. Anyone who has seen the manual knows it, so please set your own now.`),

        h('div.field', [h('label.field__label', { text: 'Signing in as' }),
          h('div.strong', { text: `${user.name} (${user.username})` })]),
        h('div.field', [h('label.field__label', { text: 'New password' }), next]),
        h('div.field', [h('label.field__label', { text: 'Repeat new password' }), again]),

        h('button.btn.btn--primary.btn--lg.btn--block#save', {
          type: 'button', text: 'Save and continue',
          onclick: e => busy(e.currentTarget, async () => {
            const a = next.value, b = again.value;
            const problem = checkPassword(a, user.username);
            if (problem) { toast('warn', 'Please choose a different password', problem); next.focus(); return; }
            if (a !== b) { toast('warn', 'The two passwords do not match'); again.focus(); return; }
            try {
              // Sign in first so the write passes the permission check.
              store.signIn(user);
              const saved = await store.setPassword(user.id, a);
              toastOk('Password changed', 'Remember it — there is no way to recover it.');
              onSignedIn(saved);
            } catch (err) { fail(err, 'Could not change the password'); }
          })
        }),

        h('div.text-xs.text-muted', { style: { textAlign: 'center' },
          text: 'At least 4 characters. Write it somewhere safe — it cannot be recovered, only reset by an administrator.' })
      ]))
    ]);
  }

  drawLogin('');
}
