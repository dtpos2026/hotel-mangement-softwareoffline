/**
 * Toasts, modals and confirmations — requirement 34.
 *
 * Every write in this application reports back: a success toast, an error toast
 * carrying the domain's own message, and a confirmation step in front of
 * anything destructive.
 */

import { h, mount, qs, busy } from './dom.js';

let toastHost = null;

function host() {
  if (!toastHost) {
    toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

export function toast(kind, title, body, ms) {
  const node = h('div.toast.toast--' + kind, [
    h('div', { style: { minWidth: '0', flex: '1' } }, [
      h('div.toast__title', { text: title }),
      body ? h('div.toast__body', { text: body }) : null
    ]),
    h('button.toast__close', { type: 'button', 'aria-label': 'Dismiss', text: '×', onclick: () => node.remove() })
  ]);
  host().appendChild(node);
  const life = ms || (kind === 'error' ? 8000 : 3600);
  setTimeout(() => {
    node.style.transition = 'opacity 180ms linear';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  }, life);
  return node;
}

export const ok    = (title, body) => toast('ok', title, body);
export const info  = (title, body) => toast('info', title, body);
export const warn  = (title, body) => toast('warn', title, body, 6000);

/** Shows a domain error, including the field list and booking conflicts. */
export function fail(err, fallbackTitle) {
  const message = err && err.message ? err.message : String(err || 'Something went wrong.');
  let detail = '';
  if (err && err.conflicts && err.conflicts.length) {
    detail = err.conflicts.map(c => c.text || `${c.code} · ${c.guestName}`).join('\n');
  } else if (err && err.details && err.details.length) {
    detail = err.details.join('\n');
  } else if (err && err.fields) {
    detail = Object.values(err.fields).join(' ');
  }
  console.error('[hms]', err);
  return toast('error', fallbackTitle || message, fallbackTitle ? message : detail, 9000);
}

/* ---------------------------------------------------------------- modals */

const stack = [];

/**
 * Opens a modal. `render` receives an api with { close, body, footer } so a
 * screen can rebuild the contents in place.
 */
export function modal(opts) {
  const o = opts || {};
  const bodyEl = h('div.modal__body');
  const footEl = h('div.modal__foot');

  const backdrop = h('div.modal-backdrop', {
    role: 'dialog', 'aria-modal': 'true',
    onmousedown: (e) => { if (e.target === backdrop && o.dismissable !== false) close(); }
  });

  const panel = h('div.modal' + (o.size === 'wide' ? '.modal--wide' : o.size === 'xwide' ? '.modal--xwide' : ''), [
    h('div.modal__head', [
      h('div', { style: { minWidth: '0' } }, [
        h('div.modal__title', { text: o.title || '' }),
        o.subtitle ? h('div.modal__sub', { text: o.subtitle }) : null
      ]),
      o.dismissable === false ? null :
        h('button.modal__close', { type: 'button', 'aria-label': 'Close', text: '×', onclick: () => close() })
    ]),
    bodyEl,
    footEl
  ]);
  backdrop.appendChild(panel);

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    backdrop.remove();
    const i = stack.indexOf(handle);
    if (i > -1) stack.splice(i, 1);
    document.removeEventListener('keydown', onKey, true);
    if (!stack.length) document.body.style.overflow = '';
    if (o.onClose) o.onClose(result);
  }

  function onKey(e) {
    if (stack[stack.length - 1] !== handle) return;
    if (e.key === 'Escape' && o.dismissable !== false) { e.stopPropagation(); close(); }
  }

  const handle = {
    close,
    el: panel,
    body: (content) => { mount(bodyEl, content); return handle; },
    footer: (content) => { mount(footEl, content); footEl.style.display = content ? '' : 'none'; return handle; },
    setTitle: (text) => { qs('.modal__title', panel).textContent = text; return handle; }
  };

  if (o.body) handle.body(o.body);
  if (o.footer) handle.footer(o.footer); else footEl.style.display = 'none';
  if (o.render) o.render(handle);

  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey, true);
  stack.push(handle);

  setTimeout(() => {
    const target = qs('[autofocus]', panel) || qs('input:not([type=hidden]),select,textarea,button.btn--primary', panel);
    if (target) target.focus();
  }, 30);

  return handle;
}

/** A yes/no step. Resolves true only if the user confirms. */
export function confirm(opts) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  return new Promise(resolve => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    const dialog = modal({
      title: o.title || 'Please confirm',
      size: o.size,
      dismissable: o.dismissable !== false,
      onClose: () => done(false),
      body: [
        o.message ? h('p', { text: o.message, style: { fontSize: '13.5px', lineHeight: '1.55' } }) : null,
        o.detail ? h('div.alert.alert--' + (o.tone || 'warn'), { style: { marginTop: '12px' } }, [
          h('div', [
            o.detailTitle ? h('div.alert__title', { text: o.detailTitle }) : null,
            h('div', { style: { whiteSpace: 'pre-line', marginTop: o.detailTitle ? '3px' : 0 }, text: o.detail })
          ])
        ]) : null,
        o.extra || null
      ],
      footer: [
        h('button.btn', { type: 'button', text: o.cancelLabel || 'Cancel', onclick: () => { done(false); dialog.close(); } }),
        h('button.btn.' + (o.danger ? 'btn--danger' : 'btn--primary'), {
          type: 'button', text: o.confirmLabel || 'Confirm',
          onclick: (e) => busy(e.currentTarget, () => { done(true); dialog.close(); })
        })
      ]
    });
  });
}

/** A one-field prompt — used for void reasons, which are mandatory. */
export function promptText(opts) {
  const o = opts || {};
  return new Promise(resolve => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const input = o.multiline
      ? h('textarea.textarea', { name: 'value', placeholder: o.placeholder || '', autofocus: true })
      : h('input.input', { name: 'value', placeholder: o.placeholder || '', autofocus: true, value: o.value || '' });
    const error = h('div.field__error', { style: { display: 'none' } });

    const submit = () => {
      const value = String(input.value || '').trim();
      if (o.required !== false && !value) {
        error.textContent = o.requiredMessage || 'This is required.';
        error.style.display = '';
        input.classList.add('is-invalid');
        input.focus();
        return;
      }
      done(value);
      dialog.close();
    };

    if (!o.multiline) input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

    const dialog = modal({
      title: o.title || 'Enter a value',
      onClose: () => done(null),
      body: h('div.field', [
        o.label ? h('label.field__label', { text: o.label }) : null,
        input,
        o.hint ? h('div.field__hint', { text: o.hint }) : null,
        error
      ]),
      footer: [
        h('button.btn', { type: 'button', text: 'Cancel', onclick: () => { done(null); dialog.close(); } }),
        h('button.btn.' + (o.danger ? 'btn--danger' : 'btn--primary'), { type: 'button', text: o.confirmLabel || 'Save', onclick: submit })
      ]
    });
  });
}

export function closeAllModals() { stack.slice().forEach(m => m.close()); }
