/**
 * Activation and licence status.
 *
 * Shown full-screen when the trial has run out or a stored licence has gone
 * bad, and reachable from Settings at any time. The wording is deliberately
 * plain: a receptionist who cannot open the software at 9pm needs to know
 * exactly what to send their supplier, not a error code.
 */

import { h, mount, qs, busy } from '../dom.js';
import { card, alert, field, railRows, badge } from '../components.js';
import { toast, ok as toastOk, fail, confirm } from '../feedback.js';
import * as host from '../../core/host.js';
import { formatKey, KEY_BYTES } from '../../core/license.js';

const KEY_CHARS = KEY_BYTES * 8 / 5;   // 144

/** Full-screen gate. Nothing else is reachable until a licence is accepted. */
export function activationGate(root, status, onActivated) {
  const holder = h('div', {
    style: {
      minHeight: '100vh', background: 'var(--canvas)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 20px'
    }
  });

  const body = h('div', { style: { width: '100%', maxWidth: '620px' } });
  holder.appendChild(body);
  mount(root, holder);

  const draw = (current) => {
    mount(body, [
      h('div', { style: { textAlign: 'center', marginBottom: '22px' } }, [
        h('div', {
          style: {
            width: '54px', height: '54px', margin: '0 auto 14px', borderRadius: '11px',
            background: 'var(--accent)', color: '#F2EBF8', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-mono)', fontWeight: '700', fontSize: '18px'
          }, text: 'HR'
        }),
        h('h1', { style: { fontSize: '21px' }, text: 'Hotel Register' }),
        h('div.text-sm.text-muted', { style: { marginTop: '4px' }, text: 'Offline Accommodation Management' })
      ]),
      activationCard(current, onActivated)
    ]);
  };

  draw(status);
  return { redraw: draw };
}

/** The card itself — reused inside Settings, where it is not a gate. */
export function activationCard(status, onActivated, opts) {
  const o = opts || {};
  const inline = !!o.inline;
  const keyBox = h('textarea.textarea.input--mono', {
    name: 'licenceKey',
    rows: 5,
    placeholder: '040G7R-859R01-J00500-ZG0000\n07AVGA-G532B0-000001-D7MASS\n…',
    style: { letterSpacing: '0.04em', lineHeight: '1.7', fontSize: '13px' },
    autofocus: !inline,
    oninput: () => updateCount()
  });
  const counter = h('div.field__hint');
  const machineRow = h('div');

  function cleanKey() {
    return String(keyBox.value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  function updateCount() {
    const n = cleanKey().length;
    counter.textContent = n === 0
      ? `A licence key is ${KEY_CHARS} characters. Paste it here — spaces, dashes and line breaks are ignored.`
      : n < KEY_CHARS ? `${n} of ${KEY_CHARS} characters — the key looks incomplete.`
      : n > KEY_CHARS ? `${n} characters — that is longer than a licence key.`
      : `${n} of ${KEY_CHARS} characters — ready to activate.`;
    counter.style.color = n === KEY_CHARS ? 'var(--deodar)' : (n > KEY_CHARS ? 'var(--due)' : 'var(--muted)');
  }
  updateCount();

  host.machineCode().then(code => {
    if (!code) return;
    mount(machineRow, h('div', {
      style: {
        background: 'var(--surface-sunk)', border: '1px solid var(--line)',
        borderRadius: 'var(--r)', padding: '10px 12px', marginTop: '12px'
      }
    }, [
      h('div.field__label', { text: "This computer's code" }),
      h('div.row', { style: { marginTop: '4px', gap: '10px' } }, [
        h('span.mono.strong', { style: { fontSize: '15px', letterSpacing: '0.06em' }, text: code }),
        h('button.btn.btn--sm.btn--ghost', {
          type: 'button', text: 'Copy',
          onclick: async () => {
            try { await navigator.clipboard.writeText(code); toastOk('Copied', code); }
            catch { toast('warn', 'Could not copy', 'Select the code and copy it by hand.'); }
          }
        })
      ]),
      h('div.field__hint', { style: { marginTop: '4px' },
        text: 'Send this to your supplier if your licence is tied to one computer.' })
    ]));
  });

  const statusTone = status.licensed ? (status.expiringSoon ? 'warn' : 'ok')
    : (status.status === 'trial' ? 'info' : 'due');

  const activate = async (e) => busy(e.currentTarget, async () => {
    const key = cleanKey();
    if (!key) { toast('warn', 'Enter your licence key'); keyBox.focus(); return; }
    if (key.length !== KEY_CHARS) {
      toast('warn', 'That key looks incomplete',
        `A licence key is ${KEY_CHARS} characters; this one has ${key.length}. Paste the whole thing, including every line.`);
      return;
    }
    try {
      const result = await host.activateLicence(key);
      if (!result.ok) { toast('error', 'Could not activate', result.message); return; }
      toastOk('Licence activated.', result.status && result.status.message);
      if (onActivated) onActivated(result.status);
    } catch (err) { fail(err, 'Could not activate'); }
  });

  return card({
    title: status.licensed ? 'Licence' : 'Activate this copy',
    tools: [badge(statusLabel(status), statusTone)]
  }, h('div.stack', [
    alert(statusTone, statusHeadline(status), status.message),

    status.licensed && status.details ? railRows([
      { k: 'Plan', v: status.details.plan },
      { k: 'Licence no', v: status.details.licenceNo },
      { k: 'Issued', v: status.details.issued },
      { k: 'Expires', v: status.details.expires },
      { k: 'Units allowed', v: status.details.units },
      { k: 'Users allowed', v: status.details.users },
      { k: 'Computer', v: status.details.machineBound ? 'Tied to this computer' : 'Any computer' }
    ]) : null,

    status.licensed && status.details && status.details.features.length
      ? h('div', [
          h('div.field__label', { text: 'Included' }),
          h('div.row.row--tight', { style: { marginTop: '6px' } },
            status.details.features.map(f => badge(f, 'muted')))
        ])
      : null,

    !status.licensed ? h('div.field', [
      h('label.field__label', { text: 'Licence key' }),
      keyBox,
      counter
    ]) : null,

    !status.licensed ? machineRow : null,

    !status.licensed ? h('div.row', { style: { marginTop: '4px' } }, [
      h('button.btn.btn--primary.btn--lg', { type: 'button', text: 'Activate', onclick: activate }),
      host.isDesktop ? h('button.btn', {
        type: 'button', text: 'Load from file…',
        onclick: async () => {
          const result = await host.openFile({
            title: 'Choose your licence file',
            filters: [{ name: 'Licence file', extensions: ['lic', 'txt'] }]
          });
          if (result.cancelled) return;
          if (!result.ok) { toast('error', 'Could not read the file', result.message); return; }
          keyBox.value = String(result.content || '').trim();
          updateCount();
          toastOk('Licence file loaded', 'Press Activate to continue.');
        }
      }) : null,
      status.status === 'trial' && status.trialDaysLeft > 0 && o.onContinueTrial
        ? h('button.btn.btn--ghost', { type: 'button', text: `Continue trial (${status.trialDaysLeft} days left)`,
            onclick: () => o.onContinueTrial() })
        : null
    ]) : null,

    status.licensed && host.isDesktop ? h('div.row', [
      h('button.btn', {
        type: 'button', text: 'Remove licence from this computer',
        onclick: async () => {
          const go = await confirm({
            title: 'Remove the licence?',
            message: 'The software will stop working on this computer until a licence is entered again. Your data is not touched. Keep your key — you will need it to activate again or to move to another computer.',
            danger: true, confirmLabel: 'Remove licence'
          });
          if (!go) return;
          const result = await host.deactivateLicence();
          toastOk('Licence removed');
          if (onActivated) onActivated(result.status);
        }
      })
    ]) : null,

    h('div.text-xs.text-muted', { style: { marginTop: '6px', lineHeight: '1.6' },
      text: 'No internet connection is used. Your licence is checked on this computer only.' })
  ]));
}

function statusLabel(status) {
  switch (status.status) {
    case 'valid': return 'Licensed';
    case 'trial': return status.licensed ? 'Trial licence' : 'Trial';
    case 'expired': return 'Expired';
    case 'wrong_machine': return 'Wrong computer';
    case 'tampered': return 'Invalid key';
    case 'malformed': return 'Unreadable key';
    case 'future_version': return 'Newer licence';
    case 'web': return 'Preview';
    default: return 'Not activated';
  }
}

function statusHeadline(status) {
  if (status.licensed && status.expiringSoon) return 'Your licence is about to expire';
  if (status.licensed) return 'This copy is licensed';
  switch (status.status) {
    case 'trial': return `Trial — ${status.trialDaysLeft} day(s) remaining`;
    case 'expired': return 'Your licence has expired';
    case 'wrong_machine': return 'This licence belongs to another computer';
    case 'tampered': return 'This licence key is not valid';
    case 'future_version': return 'This licence needs a newer version';
    default: return 'Enter your licence key to continue';
  }
}

/** Settings tab. */
export function render(ctx) {
  const { app } = ctx;
  const holder = h('div.stack');
  host.licenceStatus().then(status => {
    host.setLicence(status);
    mount(holder, activationCard(status, () => app.refresh(), { inline: true }));
  });
  return holder;
}
