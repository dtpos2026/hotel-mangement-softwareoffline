/**
 * Activation and licence status.
 *
 * Shown full-screen until the software is activated, and reachable from
 * Settings afterwards. Activation needs the internet once; the wording says so
 * plainly, because a receptionist standing at a desk with no signal needs to
 * know whether to wait or to call someone.
 */

import { h, mount, qs, busy } from '../dom.js';
import { card, alert, railRows, badge } from '../components.js';
import { toast, ok as toastOk, fail, confirm } from '../feedback.js';
import * as host from '../../core/host.js';
import { formatKey, normaliseKey, isWellFormed, KEY_GROUPS, KEY_GROUP_LEN,
         SUPPORT_CONTACT as SUPPORT } from '../../core/licence-model.js';

const KEY_CHARS = KEY_GROUPS * KEY_GROUP_LEN;

/** Full-screen gate. Nothing else is reachable until the licence is accepted. */
export function activationGate(root, status, onActivated) {
  const body = h('div', { style: { width: '100%', maxWidth: '560px' } });
  mount(root, h('div', {
    style: {
      minHeight: '100vh', background: 'var(--canvas)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 20px'
    }
  }, body));

  const draw = (current) => mount(body, [
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

  draw(status);
  return { redraw: draw };
}

/** The card itself, reused inside Settings where it is not a gate. */
export function activationCard(status, onActivated, opts) {
  const o = opts || {};
  const machineRow = h('div');
  const helpRow = h('div');

  const keyInput = h('input.input.input--mono', {
    name: 'licenceKey',
    placeholder: 'HR-XXXX-XXXX-XXXX',
    autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    autofocus: !o.inline,
    style: { fontSize: '19px', letterSpacing: '0.13em', textAlign: 'center', padding: '13px 12px' },
    oninput: (e) => {
      // Reformat as they type, keeping the caret at the end.
      const body = normaliseKey(e.target.value).slice(0, KEY_CHARS);
      e.target.value = body ? formatKey(body) : '';
      updateHelp();
    },
    onkeydown: (e) => { if (e.key === 'Enter') qs('[data-activate]', helpRow.parentNode || document).click(); }
  });

  function typed() { return normaliseKey(keyInput.value); }

  function updateHelp() {
    const n = typed().length;
    mount(helpRow, h('div.field__hint', {
      style: { color: n === KEY_CHARS ? 'var(--deodar)' : 'var(--muted)' },
      text: n === 0
        ? 'Type the key exactly as your supplier sent it. Capitals and dashes are added for you.'
        : n < KEY_CHARS ? `${n} of ${KEY_CHARS} characters`
        : 'Ready to activate.'
    }));
  }
  updateHelp();

  host.machineCode().then(code => {
    if (!code) return;
    mount(machineRow, h('div', {
      style: {
        background: 'var(--surface-sunk)', border: '1px solid var(--line)',
        borderRadius: 'var(--r)', padding: '10px 12px'
      }
    }, [
      h('div.field__label', { text: "This computer's code" }),
      h('div.row', { style: { marginTop: '4px', gap: '10px' } }, [
        h('span.mono.strong', { style: { fontSize: '15px', letterSpacing: '0.06em' }, text: code }),
        h('button.btn.btn--sm.btn--ghost', {
          type: 'button', text: 'Copy',
          onclick: async () => {
            try { await navigator.clipboard.writeText(code); toastOk('Copied', code); }
            catch { toast('warn', 'Could not copy', 'Read the code out instead.'); }
          }
        })
      ]),
      h('div.field__hint', { style: { marginTop: '4px' },
        text: 'Your supplier may ask for this when issuing or moving a licence.' })
    ]));
  });

  const tone = status.licensed ? (status.expiringSoon ? 'warn' : 'ok')
    : (status.status === 'offline' ? 'info' : 'due');

  async function activate(e) {
    return busy(e.currentTarget, async () => {
      const key = typed();
      if (!key) { toast('warn', 'Enter your licence key'); keyInput.focus(); return; }
      if (!isWellFormed(key)) {
        toast('warn', 'That key is not complete',
          `A licence key has ${KEY_CHARS} characters after HR-. This one has ${key.length}.`);
        keyInput.focus();
        return;
      }
      try {
        const result = await host.activateLicence(formatKey(key));
        if (!result.ok) {
          toast(result.offline ? 'warn' : 'error',
            result.offline ? 'Internet needed to activate' : 'Could not activate',
            result.message);
          return;
        }
        toastOk('Activated.', result.status && result.status.message);
        if (onActivated) onActivated(result.status);
      } catch (err) { fail(err, 'Could not activate'); }
    });
  }

  const d = status.details;

  return card({
    title: status.licensed ? 'Licence' : 'Activate your software',
    tools: [badge(statusLabel(status), tone)]
  }, h('div.stack', [
    alert(tone, headline(status), status.message),

    status.licensed && d ? railRows([
      { k: 'Licensed to', v: d.businessName || '—' },
      d.ownerName ? { k: 'Owner', v: d.ownerName } : null,
      d.phone ? { k: 'Phone', v: d.phone } : null,
      { k: 'Licence key', v: d.key },
      { k: 'Plan', v: d.plan },
      { k: 'Activated', v: d.activatedAt ? String(d.activatedAt).slice(0, 10) : '—' },
      { k: 'Expires', v: d.expires },
      { k: 'Units allowed', v: d.units },
      { k: 'Users allowed', v: d.users },
      { k: 'Last checked', v: status.lastVerifiedAt ? String(status.lastVerifiedAt).slice(0, 10) : '—' }
    ]) : null,

    status.licensed && d && d.featureLabels.length ? h('div', [
      h('div.field__label', { text: 'Included' }),
      h('div.row.row--tight', { style: { marginTop: '6px' } }, d.featureLabels.map(f => badge(f, 'muted')))
    ]) : null,

    !status.licensed ? h('div.field', [
      h('label.field__label', { text: 'Licence key' }),
      keyInput,
      helpRow
    ]) : null,

    !status.licensed ? machineRow : null,

    !status.licensed ? h('div.row', [
      h('button.btn.btn--primary.btn--lg', { type: 'button', 'data-activate': '1', text: 'Activate', onclick: activate })
    ]) : null,

    needsVendor(status) ? supportCard() : null,

    !status.licensed && !needsVendor(status) ? alert('info', 'Internet is needed once',
      'Activation checks your key with the licence server. After that the software runs completely offline — no connection is needed for day-to-day work.') : null,

    status.licensed && host.isDesktop ? h('div.row', [
      h('button.btn', {
        type: 'button', text: 'Check licence now',
        onclick: e => busy(e.currentTarget, async () => {
          const next = await host.recheckLicence();
          toast(next.licensed ? 'ok' : 'warn',
            next.licensed ? 'Licence confirmed' : 'Licence problem', next.message);
          if (onActivated) onActivated(next);
        })
      }),
      h('button.btn', {
        type: 'button', text: 'Remove from this computer',
        onclick: async () => {
          const go = await confirm({
            title: 'Remove the licence?',
            message: 'The software will stop opening on this computer until a key is entered again. Your data is not touched. Keep the key — you will need it to activate again, and your supplier must release it before it works on another computer.',
            danger: true, confirmLabel: 'Remove licence'
          });
          if (!go) return;
          const next = await host.deactivateLicence();
          toastOk('Licence removed');
          if (onActivated) onActivated(next);
        }
      })
    ]) : null
  ]));
}

/** True when nothing the person at the desk can do will fix this. */
function needsVendor(status) {
  return ['suspended', 'revoked', 'expired', 'wrong_machine'].indexOf(status.status) > -1;
}

/**
 * Who to ring, on the screen that stops them working.
 *
 * A suspended licence is a conversation between the owner and Digital Target,
 * but the person reading this is usually a receptionist with a guest at the
 * desk. Giving them the number, tappable, is the whole job of this card — and
 * it says plainly that the data is safe, because that is the first thing
 * anybody fears when a screen locks.
 */
function supportCard() {
  const rows = SUPPORT.whatsapp.map(n => h('a.btn.btn--block', {
    href: 'https://wa.me/' + n.replace(/\D/g, ''),
    target: '_blank', rel: 'noopener',
    style: { justifyContent: 'space-between' }
  }, [
    h('span', { text: 'WhatsApp ' + n }),
    h('span.text-xs.text-muted', { text: 'opens WhatsApp' })
  ]));

  return card({ title: 'Contact ' + SUPPORT.company }, h('div.stack.stack--sm', [
    h('div', {
      style: {
        fontFamily: 'var(--font-mono)', fontSize: '17px', fontWeight: '700',
        color: 'var(--accent)', letterSpacing: '0.01em'
      },
      text: SUPPORT.phone
    }),
    h('div.text-sm.text-muted', {
      text: 'Your bookings, guests and payments are all still on this computer and are not affected. Everything comes back as soon as the licence is active again.'
    }),
    ...rows,
    h('a.btn.btn--block', { href: 'mailto:' + SUPPORT.email, text: SUPPORT.email })
  ]));
}

function statusLabel(status) {
  switch (status.status) {
    case 'active': return 'Licensed';
    case 'expired': return 'Expired';
    case 'suspended': return 'Suspended';
    case 'revoked': return 'Inactive';
    case 'wrong_machine': return 'Another computer';
    case 'not_found': return 'Unknown key';
    case 'tampered': return 'Re-activation needed';
    case 'recheck_required': return 'Check needed';
    case 'offline': return 'No internet';
    case 'web': return 'Preview';
    default: return 'Not activated';
  }
}

function headline(status) {
  if (status.licensed && status.expiringSoon) return 'Your licence is about to expire';
  if (status.licensed) return 'This copy is licensed';
  switch (status.status) {
    case 'expired': return 'Your licence has expired';
    case 'suspended': return 'This licence is on hold';
    case 'revoked': return 'This licence is no longer active';
    case 'wrong_machine': return 'This licence is in use on another computer';
    case 'not_found': return 'That key was not recognised';
    case 'tampered': return 'Please activate again';
    case 'recheck_required': return 'Connect to the internet once';
    case 'offline': return 'No internet connection';
    default: return 'Enter your licence key to begin';
  }
}

/** Settings tab. */
export function render(ctx) {
  const { app } = ctx;
  const holder = h('div.stack', h('div.text-sm.text-muted', { text: 'Checking licence…' }));
  host.licenceStatus().then(status => {
    host.setLicence(status);
    mount(holder, activationCard(status, () => app.refresh(), { inline: true }));
  });
  return holder;
}
