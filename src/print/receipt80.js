/**
 * 80mm thermal receipts.
 *
 * Two modes, both professional:
 *
 *   NORMAL   generous line height, section rules, a blank line between blocks.
 *   COMPACT  roughly 35% shorter vertically — achieved by tightening leading,
 *            removing the inter-block gaps and dropping one type step. It is
 *            not dotted, not hairline and not shrunk to unreadability; every
 *            line is the same content, just set tighter.
 *
 * Page geometry comes entirely from printer settings, so a till that only
 * images 72mm and one that images 76mm are both a settings change, not a code
 * change. Left and right margins are separate values and default equal, so the
 * text block sits visually centred on the paper.
 */

import { printBase, escapeHtml, printerSettings, contentWidthMm } from './printer.js';
import { formatMoney, toMoney } from '../core/money.js';
import { formatDate, formatDateTime, formatTime, nowIso } from '../core/dates.js';
import { methodName } from '../domain/payments.js';
import { maskCnic } from '../core/validate.js';

/* ------------------------------------------------------------------- style */

function receiptCss(s, compact) {
  const width = contentWidthMm(s);
  const font = compact ? s.compactFontSizePt : s.fontSizePt;
  const lh = compact ? 1.24 : 1.45;
  const gap = compact ? 1.4 : 3.4;          // mm between blocks
  const rulePad = compact ? 0.8 : 1.8;      // mm around a rule

  return `
    ${printBase()}
    @page { size: ${s.widthMm}mm auto; margin: 0; }
    html, body { width: ${s.widthMm}mm; }
    body {
      font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      font-size: ${font}pt;
      line-height: ${lh};
      color: #000;
      padding: ${s.marginTopMm}mm ${s.marginRightMm}mm ${s.marginBottomMm}mm ${s.marginLeftMm}mm;
    }
    .r { width: ${width}mm; }
    .c { text-align: center; }
    .b { font-weight: 700; }
    .num { font-variant-numeric: tabular-nums; font-family: 'Consolas', 'Menlo', monospace; }

    .logo { display: block; margin: 0 auto ${compact ? 1 : 2}mm; max-width: ${Math.min(s.logoSizePx, width * 3.6)}px; max-height: ${compact ? Math.round(s.logoSizePx * 0.62) : s.logoSizePx}px; object-fit: contain; }
    .title { font-size: ${(font + (compact ? 2.5 : 3.5)).toFixed(1)}pt; font-weight: 700; letter-spacing: -0.01em; text-align: center; line-height: 1.16; }
    .sub   { font-size: ${(font - 1).toFixed(1)}pt; text-align: center; line-height: ${compact ? 1.2 : 1.35}; }

    .rule      { border-top: 1px solid #000; margin: ${rulePad}mm 0; }
    .rule--sub { border-top: 1px dashed #555; margin: ${rulePad}mm 0; }
    .gap { height: ${gap}mm; }

    .kv { display: flex; justify-content: space-between; gap: 3mm; align-items: baseline; }
    .kv > span:first-child { flex: 0 1 auto; }
    .kv > span:last-child  { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .kv--wrap > span:last-child { white-space: normal; text-align: right; }

    table.items { width: 100%; }
    table.items th {
      font-size: ${(font - 1.5).toFixed(1)}pt; text-transform: uppercase; letter-spacing: 0.04em;
      text-align: left; padding: 0 0 ${compact ? 0.5 : 1}mm; border-bottom: 1px solid #000; font-weight: 700;
    }
    table.items th.n, table.items td.n { text-align: right; }
    table.items td { padding: ${compact ? 0.55 : 1.15}mm 0; vertical-align: top; font-size: ${font}pt; }
    table.items td.desc { padding-right: 2mm; word-break: break-word; }
    table.items tr.sub td { font-size: ${(font - 1.5).toFixed(1)}pt; color: #333; padding-top: 0; }

    .total { font-size: ${(font + 2.5).toFixed(1)}pt; font-weight: 700; }
    .balance { font-size: ${(font + 2).toFixed(1)}pt; font-weight: 700; }
    .foot { font-size: ${(font - 1.5).toFixed(1)}pt; text-align: center; line-height: ${compact ? 1.25 : 1.4}; }
    .tail { height: ${compact ? 4 : 9}mm; }
    .words { font-size: ${(font - 1.5).toFixed(1)}pt; font-style: italic; }
  `;
}

/* -------------------------------------------------------------- fragments */

function head(property, settings, compact, docTitle) {
  const bits = [];
  if (settings.showLogo && property.logo) {
    bits.push(`<img class="logo" src="${escapeHtml(property.logo)}" alt="" />`);
  }
  bits.push(`<div class="title">${escapeHtml(property.name || 'Property')}</div>`);
  const line2 = [property.address, property.city].filter(Boolean).join(', ');
  if (line2) bits.push(`<div class="sub">${escapeHtml(line2)}</div>`);
  const contact = [property.phone, property.whatsapp && property.whatsapp !== property.phone ? 'WA ' + property.whatsapp : '']
    .filter(Boolean).join('  ·  ');
  if (contact) bits.push(`<div class="sub num">${escapeHtml(contact)}</div>`);
  if (!compact) bits.push('<div class="gap"></div>');
  bits.push(`<div class="rule"></div>`);
  bits.push(`<div class="c b" style="letter-spacing:0.06em;text-transform:uppercase">${escapeHtml(docTitle)}</div>`);
  bits.push(`<div class="rule"></div>`);
  return bits.join('');
}

function kv(label, value, cls) {
  return `<div class="kv ${cls || ''}"><span>${escapeHtml(label)}</span><span class="num">${escapeHtml(value)}</span></div>`;
}

function foot(property, settings, compact, extra) {
  const bits = [`<div class="rule"></div>`];
  if (extra) bits.push(`<div class="foot">${extra}</div>`);
  if (property.receiptFooter) bits.push(`<div class="foot">${escapeHtml(property.receiptFooter)}</div>`);
  if (!compact) bits.push('<div class="gap"></div>');
  bits.push(`<div class="foot" style="opacity:0.75">Software by Digital Target</div>`);
  bits.push(`<div class="tail"></div>`);
  return bits.join('');
}

function wrap(css, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt</title><style>${css}</style></head><body><div class="r">${body}</div></body></html>`;
}

/* ----------------------------------------------------------------- guest bill */

/**
 * The full guest bill — the document printed at check-out.
 * `bill` is the frozen invoice snapshot when one exists.
 */
export function guestBill(store, ctx) {
  const s = printerSettings(store);
  const compact = (ctx.mode || s.mode) === 'compact';
  const property = store.property;
  const currency = property.currency || 'Rs';
  const money = v => formatMoney(v, currency);

  const { reservation, guest, unit, bill } = ctx;
  const b = [];

  b.push(head(property, s, compact, ctx.title || 'Guest Bill'));

  b.push(kv(ctx.invoiceNo ? 'Invoice' : 'Booking', ctx.invoiceNo || reservation.code));
  b.push(kv('Date', formatDateTime(ctx.issuedAt || nowIso())));
  if (reservation.registerNo) b.push(kv('Register', reservation.registerNo));
  b.push(`<div class="rule--sub"></div>`);

  b.push(kv('Guest', guest ? guest.fullName : '—', 'kv--wrap'));
  if (guest && guest.cnic) b.push(kv('CNIC', store.session.can('guest.viewCnic') ? guest.cnic : maskCnic(guest.cnic)));
  else if (guest && guest.passport) b.push(kv('Passport', guest.passport));
  if (guest && guest.phone) b.push(kv('Phone', guest.phone));
  b.push(kv(store.unitWord(), unit ? unit.code : '—'));
  b.push(kv('Check-in', formatDate(reservation.checkIn)));
  b.push(kv('Check-out', formatDate(reservation.checkOut)));
  b.push(kv('Nights', String(reservation.nights)));
  const people = `${reservation.adults} adult${reservation.adults === 1 ? '' : 's'}` +
    (reservation.children ? `, ${reservation.children} child${reservation.children === 1 ? '' : 'ren'}` : '');
  b.push(kv('Guests', people));

  if (!compact) b.push('<div class="gap"></div>');

  // Charge table
  b.push(`<table class="items"><thead><tr>
      <th class="desc">Description</th><th class="n">Qty</th><th class="n">Amount</th>
    </tr></thead><tbody>`);
  for (const line of bill.lines) {
    b.push(`<tr>
      <td class="desc">${escapeHtml(line.description)}</td>
      <td class="n num">${escapeHtml(String(line.qty))}</td>
      <td class="n num">${escapeHtml(String(toMoney(line.amount).toLocaleString('en-US')))}</td>
    </tr>`);
    if (!compact && Number(line.qty) > 1 && toMoney(line.rate) > 0) {
      b.push(`<tr class="sub"><td class="desc" colspan="3">@ ${money(line.rate)} each</td></tr>`);
    }
  }
  b.push(`</tbody></table>`);
  b.push(`<div class="rule"></div>`);

  b.push(kv('Subtotal', money(bill.gross)));
  if (bill.discount > 0) b.push(kv(bill.discountLabel || 'Discount', '− ' + money(bill.discount)));
  if (bill.taxAmount > 0) b.push(kv(`${bill.tax.name} ${bill.tax.percent}%`, money(bill.taxAmount)));

  b.push(`<div class="rule"></div>`);
  b.push(`<div class="kv total"><span>TOTAL</span><span class="num">${escapeHtml(money(bill.total))}</span></div>`);
  b.push(`<div class="rule"></div>`);

  if (bill.paid !== 0) b.push(kv('Paid', money(bill.paid)));

  const settled = bill.balance <= 0;
  b.push(`<div class="kv balance"><span>${settled ? 'BALANCE' : 'BALANCE DUE'}</span><span class="num">${escapeHtml(money(Math.abs(bill.balance)))}${bill.balance < 0 ? ' CR' : ''}</span></div>`);

  if (bill.payments && bill.payments.length) {
    if (!compact) b.push('<div class="gap"></div>');
    b.push(`<div class="rule--sub"></div>`);
    for (const p of bill.payments) {
      b.push(kv(
        `${formatDate(String(p.at).slice(0, 10))} · ${methodName(p.method)}${p.kind === 'refund' ? ' (refund)' : ''}`,
        (p.kind === 'refund' ? '− ' : '') + money(p.amount)
      ));
    }
  }

  if (settled && !compact) {
    b.push('<div class="gap"></div>');
    b.push(`<div class="c b">** SETTLED — THANK YOU **</div>`);
  } else if (!settled) {
    b.push(`<div class="c b" style="margin-top:1.5mm">** ${escapeHtml(money(bill.balance))} OUTSTANDING **</div>`);
  }

  b.push(foot(property, s, compact, ctx.servedBy ? `Served by ${escapeHtml(ctx.servedBy)}` : ''));
  return wrap(receiptCss(s, compact), b.join(''));
}

/* ------------------------------------------------------------ payment receipt */

export function paymentReceipt(store, ctx) {
  const s = printerSettings(store);
  const compact = (ctx.mode || s.mode) === 'compact';
  const property = store.property;
  const money = v => formatMoney(v, property.currency || 'Rs');
  const { payment, guest, reservation, unit, balanceAfter } = ctx;
  const b = [];

  b.push(head(property, s, compact, payment.kind === 'refund' ? 'Refund Receipt' : payment.kind === 'advance' ? 'Advance Receipt' : 'Payment Receipt'));

  b.push(kv('Receipt', payment.code));
  b.push(kv('Date', formatDateTime(payment.at)));
  b.push(`<div class="rule--sub"></div>`);
  b.push(kv('Received from', guest ? guest.fullName : '—', 'kv--wrap'));
  if (guest && guest.phone) b.push(kv('Phone', guest.phone));
  if (reservation) {
    b.push(kv('Booking', reservation.code));
    if (unit) b.push(kv(store.unitWord(), unit.code));
    b.push(kv('Stay', `${formatDate(reservation.checkIn)} → ${formatDate(reservation.checkOut)}`));
  }
  b.push(kv('Method', methodName(payment.method)));
  if (payment.reference) b.push(kv('Reference', payment.reference, 'kv--wrap'));

  b.push(`<div class="rule"></div>`);
  b.push(`<div class="kv total"><span>${payment.kind === 'refund' ? 'REFUNDED' : 'RECEIVED'}</span><span class="num">${escapeHtml(money(payment.amount))}</span></div>`);
  b.push(`<div class="rule"></div>`);

  if (balanceAfter !== undefined && balanceAfter !== null) {
    b.push(`<div class="kv balance"><span>${balanceAfter > 0 ? 'BALANCE DUE' : 'BALANCE'}</span><span class="num">${escapeHtml(money(Math.max(0, balanceAfter)))}</span></div>`);
  }
  if (payment.notes) {
    b.push(`<div class="rule--sub"></div>`);
    b.push(`<div class="sub" style="text-align:left">${escapeHtml(payment.notes)}</div>`);
  }
  if (!compact) {
    b.push('<div class="gap"></div><div class="gap"></div>');
    b.push(`<div class="kv"><span>Received by</span><span>______________</span></div>`);
  }

  b.push(foot(property, s, compact, ctx.servedBy ? `Cashier: ${escapeHtml(ctx.servedBy)}` : ''));
  return wrap(receiptCss(s, compact), b.join(''));
}

/* ------------------------------------------------------- registration card */

/** Handed to the guest at check-in; also the copy kept at the desk. */
export function checkInSlip(store, ctx) {
  const s = printerSettings(store);
  const compact = (ctx.mode || s.mode) === 'compact';
  const property = store.property;
  const money = v => formatMoney(v, property.currency || 'Rs');
  const { reservation, guest, unit, bill } = ctx;
  const b = [];

  b.push(head(property, s, compact, 'Check-in Slip'));
  b.push(kv('Booking', reservation.code));
  if (reservation.registerNo) b.push(kv('Register', reservation.registerNo));
  b.push(kv('Checked in', formatDateTime(reservation.checkedInAt || nowIso())));
  b.push(`<div class="rule--sub"></div>`);
  b.push(kv('Guest', guest ? guest.fullName : '—', 'kv--wrap'));
  if (guest && guest.cnic) b.push(kv('CNIC', store.session.can('guest.viewCnic') ? guest.cnic : maskCnic(guest.cnic)));
  if (guest && guest.phone) b.push(kv('Phone', guest.phone));
  b.push(kv(store.unitWord(), unit ? unit.code : '—'));
  b.push(kv('Check-in', formatDate(reservation.checkIn)));
  b.push(kv('Check-out', `${formatDate(reservation.checkOut)}  ${property.checkOutTime || ''}`));
  b.push(kv('Nights', String(reservation.nights)));
  b.push(kv('Adults / Children', `${reservation.adults} / ${reservation.children}`));

  if (reservation.companions && reservation.companions.length) {
    b.push(`<div class="rule--sub"></div>`);
    b.push(`<div class="b">Accompanying</div>`);
    reservation.companions.forEach((c, i) => {
      b.push(kv(`${i + 1}. ${c.name}`, [c.relation, c.age ? c.age + 'y' : ''].filter(Boolean).join(' · '), 'kv--wrap'));
    });
  }

  b.push(`<div class="rule"></div>`);
  b.push(kv('Rate / night', money(reservation.rateSnapshot ? reservation.rateSnapshot.base : reservation.rate)));
  b.push(kv('Estimated total', money(bill.total)));
  if (bill.paid > 0) b.push(kv('Advance paid', money(bill.paid)));
  b.push(`<div class="kv balance"><span>BALANCE</span><span class="num">${escapeHtml(money(Math.max(0, bill.balance)))}</span></div>`);

  if (!compact) {
    b.push('<div class="gap"></div>');
    b.push(`<div class="sub" style="text-align:left">Check-out time ${escapeHtml(property.checkOutTime || '12:00')}. Please settle the balance before departure.</div>`);
    b.push('<div class="gap"></div>');
    b.push(`<div class="kv"><span>Guest signature</span><span>______________</span></div>`);
  }

  b.push(foot(property, s, compact, ''));
  return wrap(receiptCss(s, compact), b.join(''));
}

/* ------------------------------------------------------------- day summary */

export function dayCloseSlip(store, ctx) {
  const s = printerSettings(store);
  const compact = (ctx.mode || s.mode) === 'compact';
  const property = store.property;
  const money = v => formatMoney(v, property.currency || 'Rs');
  const f = ctx.figures;
  const b = [];

  b.push(head(property, s, compact, 'Day Close Summary'));
  b.push(kv('Date', formatDate(f.date)));
  b.push(kv('Printed', formatDateTime(nowIso())));
  if (ctx.closedBy) b.push(kv('Closed by', ctx.closedBy));
  b.push(`<div class="rule"></div>`);

  b.push(kv('Opening cash', money(f.openingBalance)));
  b.push(`<div class="rule--sub"></div>`);
  f.byMethod.filter(m => m.received || m.refunded).forEach(m => {
    b.push(kv(m.label, money(m.received - m.refunded)));
  });
  b.push(`<div class="rule--sub"></div>`);
  b.push(kv('Total received', money(f.received)));
  if (f.refunded > 0) b.push(kv('Refunds', '− ' + money(f.refunded)));
  b.push(kv('Expenses', '− ' + money(f.expenseTotal)));
  b.push(`<div class="rule"></div>`);
  b.push(`<div class="kv total"><span>NET COLLECTION</span><span class="num">${escapeHtml(money(f.netCollection - f.expenseTotal))}</span></div>`);
  b.push(`<div class="kv balance"><span>CLOSING CASH</span><span class="num">${escapeHtml(money(f.closingCash))}</span></div>`);
  b.push(`<div class="rule"></div>`);

  b.push(kv('Room revenue', money(f.roomRevenue)));
  b.push(kv('Outstanding', money(f.outstanding)));
  b.push(kv('Arrivals / Departures', `${f.arrivals} / ${f.departures}`));
  b.push(kv('Occupied', `${f.occupied} of ${f.available}  (${f.occupancy}%)`));

  if (!compact) {
    b.push('<div class="gap"></div><div class="gap"></div>');
    b.push(`<div class="kv"><span>Manager</span><span>______________</span></div>`);
  }

  b.push(foot(property, s, compact, ''));
  return wrap(receiptCss(s, compact), b.join(''));
}

/* ----------------------------------------------------------------- test print */

/**
 * The alignment page. It prints a full-width ruler so staff can confirm the
 * paper is imaging edge to edge, and states the geometry actually in use.
 */
export function testPrint(store, mode) {
  const s = printerSettings(store);
  const compact = mode === 'compact';
  const property = store.property;
  const width = contentWidthMm(s);
  const b = [];

  b.push(head(property, s, compact, 'Printer Test Page'));
  b.push(kv('Printed', formatDateTime(nowIso())));
  if (s.printerName) b.push(kv('Printer', s.printerName, 'kv--wrap'));
  b.push(`<div class="rule"></div>`);
  b.push(kv('Paper width', s.widthMm + ' mm'));
  b.push(kv('Print area', width.toFixed(1) + ' mm'));
  b.push(kv('Margins L/R', `${s.marginLeftMm} / ${s.marginRightMm} mm`));
  b.push(kv('Margins T/B', `${s.marginTopMm} / ${s.marginBottomMm} mm`));
  b.push(kv('Font size', (compact ? s.compactFontSizePt : s.fontSizePt) + ' pt'));
  b.push(kv('Mode', compact ? 'Compact (save paper)' : 'Normal'));
  b.push(`<div class="rule"></div>`);

  b.push(`<div class="sub" style="text-align:left">Both arrows below should touch the edges of the printable area with an equal gap:</div>`);
  b.push(`<div class="num" style="display:flex;justify-content:space-between"><span>&#9664;</span><span>${width.toFixed(0)}mm</span><span>&#9654;</span></div>`);
  b.push(`<div style="border-top:2px solid #000;margin:1mm 0"></div>`);
  b.push(`<div class="num" style="font-size:${(compact ? s.compactFontSizePt : s.fontSizePt) - 2}pt;letter-spacing:0">${'|....'.repeat(Math.max(4, Math.floor(width / 5)))}</div>`);
  b.push(`<div style="border-top:2px solid #000;margin:1mm 0"></div>`);

  b.push(`<div class="gap"></div>`);
  b.push(`<div class="sub" style="text-align:left">Character check</div>`);
  b.push(`<div class="num">0123456789  Rs 1,234,567</div>`);
  b.push(`<div>ABCDEFGHIJKLMNOPQRSTUVWXYZ</div>`);
  b.push(`<div>abcdefghijklmnopqrstuvwxyz</div>`);
  b.push(`<div class="gap"></div>`);
  b.push(`<table class="items"><thead><tr><th class="desc">Sample line</th><th class="n">Qty</th><th class="n">Amount</th></tr></thead><tbody>
    <tr><td class="desc">Deluxe Double — 2 nights</td><td class="n num">2</td><td class="n num">17,000</td></tr>
    <tr><td class="desc">Trout fish, Chapli Kabab, Roti</td><td class="n num">1</td><td class="n num">2,650</td></tr>
  </tbody></table>`);
  b.push(`<div class="rule"></div>`);
  b.push(`<div class="kv total"><span>TOTAL</span><span class="num">Rs 19,650</span></div>`);

  b.push(foot(property, s, compact, 'If the ruler is clipped, increase the left and right margins.'));
  return wrap(receiptCss(s, compact), b.join(''));
}

export const RECEIPTS = { guestBill, paymentReceipt, checkInSlip, dayCloseSlip, testPrint };
