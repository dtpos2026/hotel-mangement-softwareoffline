/**
 * WhatsApp: the linking panel and the send dialog.
 *
 * The panel is deliberately blunt about the risk of an unofficial client,
 * because the person clicking "send to all" is rarely the person who
 * understands what a ban costs.
 */

import { h, mount, qs, busy } from './dom.js';
import { card, alert, field, badge, railRows } from './components.js';
import { modal, toast, ok as toastOk, fail, confirm } from './feedback.js';
import * as host from '../core/host.js';
import { buildMessage, TEMPLATES } from '../domain/messaging.js';

/* ----------------------------------------------------------- link panel */

export function whatsappPanel(ctx) {
  const { store } = ctx;
  const holder = h('div.stack');
  let unsubscribe = null;

  const draw = (status) => {
    const linked = status.linked;
    const usage = status.usage || { lastHour: 0, lastDay: 0, total: 0, hourlyCap: 0, dailyCap: 0 };

    mount(holder, [
      !host.isDesktop ? alert('info', 'Desktop only',
        'WhatsApp linking is part of the installed Windows application. It cannot run in a browser preview.') : null,

      card({
        title: 'WhatsApp connection',
        tools: [linked ? badge('Linked', 'ok')
          : status.state === 'qr' ? badge('Scan the code', 'warn')
          : status.state === 'connecting' ? badge('Connecting…', 'river')
          : badge('Not linked', 'muted')]
      }, h('div.stack', [

        status.lastError ? alert('warn', 'Last message from WhatsApp', status.lastError) : null,

        linked ? [
          alert('ok', 'Connected', 'Messages will be sent from this WhatsApp number.'),
          railRows([
            { k: 'Number', v: status.me && status.me.id ? String(status.me.id).split(':')[0].split('@')[0] : '—' },
            { k: 'Name', v: (status.me && status.me.name) || '—' },
            { k: 'Sent in the last hour', v: `${usage.lastHour} of ${usage.hourlyCap}` },
            { k: 'Sent today', v: `${usage.lastDay} of ${usage.dailyCap}` },
            { k: 'Sent in total', v: String(usage.total) }
          ]),
          h('div.row', [
            h('button.btn', { type: 'button', text: 'Send a test message',
              onclick: () => sendDialog(ctx, { template: 'custom',
                text: `Test message from ${store.property.name || 'Hotel Register'}. If you can read this, WhatsApp is working.` }) }),
            h('button.btn.btn--danger', { type: 'button', text: 'Unlink this phone',
              onclick: async () => {
                const go = await confirm({
                  title: 'Unlink WhatsApp?',
                  message: 'The software will stop being able to send messages until a phone is linked again. Your WhatsApp account and chats are not affected.',
                  danger: true, confirmLabel: 'Unlink'
                });
                if (!go) return;
                draw(await host.whatsappUnlink());
                toastOk('Unlinked');
              } })
          ])
        ] : null,

        (!linked && status.qr) ? h('div.stack', [
          alert('info', 'Scan this code with the phone that has your WhatsApp',
            'On the phone: WhatsApp → Settings → Linked devices → Link a device. Point the camera at the code below. The code refreshes every few seconds.'),
          h('div', { style: {
            display: 'flex', justifyContent: 'center', padding: '18px',
            background: '#fff', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)'
          } }, h('img', { src: status.qr, width: 300, height: 300, alt: 'WhatsApp QR code',
            style: { imageRendering: 'pixelated' } })),
          h('div.text-sm.text-muted', { style: { textAlign: 'center' },
            text: 'Waiting for the phone…' })
        ]) : null,

        (!linked && !status.qr && host.isDesktop) ? h('div.row', [
          h('button.btn.btn--primary.btn--lg', {
            type: 'button',
            text: status.state === 'connecting' ? 'Connecting…' : 'Link WhatsApp',
            disabled: status.state === 'connecting',
            onclick: e => busy(e.currentTarget, async () => {
              toast('info', 'Starting WhatsApp', 'A QR code will appear in a moment.');
              draw(await host.whatsappConnect());
            })
          }),
          status.hasSession ? h('span.text-sm.text-muted', { text: 'A previous session exists and will be reused if it is still valid.' }) : null
        ]) : null
      ])),

      card({ title: 'Before you use this' }, h('div.stack', [
        alert('warn', 'This is an unofficial connection',
          'WhatsApp does not officially support third-party software. Sending many messages, or messages to people who did not ask for them, can get the number blocked by WhatsApp. That risk is yours to carry.'),
        h('div.text-sm', { style: { lineHeight: '1.65' } }, [
          h('div.strong', { text: 'How to stay safe' }),
          h('ul', { style: { margin: '6px 0 0', paddingInlineStart: '20px' } }, [
            h('li', { text: 'Only message guests who gave you their number — a booking confirmation or a receipt is expected and welcome.' }),
            h('li', { text: 'Never use it for advertising or bulk offers. That is what gets numbers banned.' }),
            h('li', { text: `The software spaces messages out and stops at ${usage.hourlyCap} an hour and ${usage.dailyCap} a day.` }),
            h('li', { text: 'Use a dedicated business number, not the owner’s personal one.' })
          ]),
          h('div', { style: { marginTop: '10px' } },
            'For high volume or full reliability, WhatsApp’s own Business API is the supported route. It needs business verification and approved message templates, and it cannot be banned for using an unofficial client.')
        ])
      ]))
    ]);
  };

  host.whatsappStatus().then(draw).catch(err => {
    mount(holder, alert('due', 'Could not read the WhatsApp status', String(err && err.message || err)));
  });
  unsubscribe = host.onWhatsappStatus(draw);
  holder.__cleanup = unsubscribe;

  return holder;
}

/* ---------------------------------------------------------- send dialog */

/**
 * Composes and sends one message. Always shows the exact text first — nobody
 * should be able to send on a guest's behalf without reading what goes out.
 */
export function sendDialog(ctx, opts) {
  const { store } = ctx;
  const o = opts || {};

  const applicable = TEMPLATES.filter(t => {
    if (t.needs === 'reservation') return !!o.reservation;
    if (t.needs === 'payment') return !!o.payment;
    return true;
  });
  let templateId = o.template || (applicable[0] && applicable[0].id) || 'custom';

  const built = () => buildMessage(store, templateId, {
    reservation: o.reservation, payment: o.payment,
    text: o.text, phone: o.phone, guest: o.guest
  });

  const initial = built();
  const guest = (initial && initial.guest) || o.guest ||
    (o.reservation ? store.db.get('guests', o.reservation.guestId) : null);

  const phoneInput = h('input.input.input--mono', {
    name: 'phone',
    value: (initial && initial.phone) || o.phone || (guest && guest.phone) || '',
    placeholder: '0300-1234567'
  });
  const textArea = h('textarea.textarea', {
    name: 'text', rows: 12,
    style: { fontSize: '13px', lineHeight: '1.6' },
    value: (initial && initial.text) || o.text || ''
  });
  const chips = h('div.chips');
  const statusRow = h('div');

  const drawChips = () => mount(chips, applicable.map(t => h('button.chip', {
    type: 'button',
    class: t.id === templateId ? 'is-on' : null,
    text: t.label,
    onclick: () => {
      templateId = t.id;
      const next = built();
      if (next) {
        textArea.value = next.text;
        if (next.phone) phoneInput.value = next.phone;
      } else {
        toast('warn', 'Nothing to send for that template',
          templateId === 'balance' ? 'This booking has no outstanding balance.' : 'The needed details are missing.');
      }
      drawChips();
    }
  })));
  drawChips();

  host.whatsappStatus().then(status => {
    mount(statusRow, status.linked
      ? null
      : alert('warn', 'WhatsApp is not linked',
          'Open Settings → WhatsApp and scan the QR code with your phone before sending.'));
  });

  const dialog = modal({
    title: 'Send on WhatsApp',
    subtitle: guest ? guest.fullName : '',
    size: 'wide',
    body: h('div.stack', [
      statusRow,
      applicable.length > 1 ? h('div.field', [
        h('div.field__label', { text: 'Message' }),
        chips
      ]) : null,
      h('div.field', [
        h('label.field__label', { text: 'Send to' }),
        phoneInput,
        h('div.field__hint', { text: 'Pakistani mobile numbers work as 0300-1234567 or +92 300 1234567.' })
      ]),
      h('div.field', [
        h('label.field__label', { text: 'Text' }),
        textArea,
        h('div.field__hint', { text: 'Read it before sending. It goes out exactly as written.' })
      ])
    ]),
    footer: [
      h('button.btn', { type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      h('button.btn', { type: 'button', text: 'Copy text',
        onclick: async () => {
          try { await navigator.clipboard.writeText(textArea.value); toastOk('Copied', 'Paste it into WhatsApp by hand if you prefer.'); }
          catch { toast('warn', 'Could not copy'); }
        } }),
      h('button.btn.btn--primary', { type: 'button', text: 'Send',
        onclick: e => busy(e.currentTarget, async () => {
          const phone = phoneInput.value.trim();
          const text = textArea.value.trim();
          if (!phone) { toast('warn', 'Enter a number'); phoneInput.focus(); return; }
          if (!text) { toast('warn', 'The message is empty'); textArea.focus(); return; }

          const result = await host.whatsappSend(phone, text);
          if (!result.ok) {
            toast(result.rateLimited ? 'warn' : 'error',
              result.rateLimited ? 'Sending limit reached' : 'Could not send', result.message);
            return;
          }
          toastOk('Sent on WhatsApp', `To ${phone}`);
          dialog.close();
          if (o.onSent) o.onSent(result);
        }) })
    ]
  });
  return dialog;
}

/** A small button screens can drop next to a guest. */
export function whatsappButton(ctx, opts) {
  const o = opts || {};
  return h('button.btn.btn--sm', {
    type: 'button',
    title: 'Send a WhatsApp message',
    text: o.label || 'WhatsApp',
    onclick: () => sendDialog(ctx, o)
  });
}
