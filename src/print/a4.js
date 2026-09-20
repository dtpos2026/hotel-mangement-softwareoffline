/**
 * A4 documents: the guest invoice and every report.
 *
 * Reports are paginated in code rather than left to the browser, because
 * browsers will not render "Page 2 of 5" — the CSS paged-media counters that
 * would do it are unimplemented. Chunking the rows into real page elements
 * gives a genuine page number, a repeated column header and a repeated
 * property masthead, which is what a printed register has to have.
 */

import { printBase, escapeHtml, printerSettings } from './printer.js';
import { formatMoney, amountInWords } from '../core/money.js';
import { formatDate, formatDateTime, nowIso } from '../core/dates.js';
import { methodName } from '../domain/payments.js';
import { maskCnic } from '../core/validate.js';

const ROWS_FIRST_PAGE = 26;
const ROWS_PER_PAGE = 36;

function a4Css(marginMm, landscape) {
  return `
    ${printBase()}
    @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: ${marginMm}mm; }
    body {
      font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      font-size: 10pt; color: #16202A; line-height: 1.4;
    }
    .sheet { page-break-after: always; }
    .sheet:last-child { page-break-after: auto; }

    .masthead { display: flex; align-items: flex-start; gap: 14px; border-bottom: 2px solid #16202A; padding-bottom: 9px; }
    .masthead__logo { width: 56px; height: 56px; object-fit: contain; flex: 0 0 56px; }
    .masthead__name { font-size: 17pt; font-weight: 700; letter-spacing: -0.01em; line-height: 1.15; }
    .masthead__meta { font-size: 8.5pt; color: #4A5560; margin-top: 3px; line-height: 1.45; }
    .masthead__right { margin-left: auto; text-align: right; }
    .masthead__doc { font-size: 13pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .masthead__sub { font-size: 8.5pt; color: #4A5560; margin-top: 3px; }

    .meta-row { display: flex; gap: 22px; flex-wrap: wrap; margin: 9px 0 11px; font-size: 9pt; }
    .meta-row > div { min-width: 0; }
    .meta-row b { display: block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: #6B7280; font-weight: 700; }

    table.grid { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
    table.grid thead { display: table-header-group; }
    table.grid th {
      text-align: left; padding: 5px 6px; border-bottom: 1.5px solid #16202A; border-top: 1px solid #16202A;
      background: #F1F3F2; font-size: 7.6pt; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; white-space: nowrap;
    }
    table.grid td { padding: 4.5px 6px; border-bottom: 1px solid #E2E6E4; vertical-align: top; }
    table.grid td.d { white-space: nowrap; }
    table.grid tr:nth-child(even) td { background: #FAFBFB; }
    table.grid .n { text-align: right; font-variant-numeric: tabular-nums; font-family: 'Consolas', monospace; white-space: nowrap; }
    table.grid tfoot td { border-top: 1.5px solid #16202A; border-bottom: 0; font-weight: 700; background: #F1F3F2; padding: 6px; }

    .summary { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .summary__item { border: 1px solid #D5DAD8; border-radius: 4px; padding: 7px 11px; min-width: 118px; }
    .summary__label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: #6B7280; font-weight: 700; }
    .summary__value { font-size: 12pt; font-weight: 700; font-variant-numeric: tabular-nums; font-family: 'Consolas', monospace; margin-top: 2px; }

    .pagefoot {
      margin-top: 12px; padding-top: 6px; border-top: 1px solid #D5DAD8;
      display: flex; justify-content: space-between; font-size: 7.5pt; color: #6B7280;
    }

    /* Invoice */
    .inv-parties { display: flex; gap: 26px; margin: 14px 0; }
    .inv-parties > div { flex: 1; }
    .inv-parties h4 { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: #6B7280; margin-bottom: 4px; }
    .inv-parties .line { font-size: 9.5pt; line-height: 1.6; }
    .inv-totals { margin-left: auto; width: 290px; margin-top: 10px; }
    .inv-totals .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 9.5pt; }
    .inv-totals .row.rule { border-top: 1px solid #C9CFCC; margin-top: 3px; padding-top: 7px; }
    .inv-totals .row.grand { border-top: 2px solid #16202A; border-bottom: 2px solid #16202A; margin-top: 5px; padding: 8px 0; font-size: 13pt; font-weight: 700; }
    .inv-totals .row .v { font-variant-numeric: tabular-nums; font-family: 'Consolas', monospace; }
    .inv-totals .row.due .v { color: #B3261E; font-weight: 700; }
    .words { margin-top: 9px; font-size: 8.5pt; font-style: italic; color: #4A5560; }
    .sign { display: flex; justify-content: space-between; margin-top: 44px; font-size: 8.5pt; }
    .sign > div { width: 190px; border-top: 1px solid #16202A; padding-top: 4px; text-align: center; color: #4A5560; }
    .notefoot { margin-top: 18px; padding-top: 8px; border-top: 1px solid #D5DAD8; font-size: 8.5pt; color: #4A5560; }
    .stamp { display: inline-block; border: 2px solid #4B7F52; color: #1F3A2E; font-weight: 700; padding: 3px 12px; border-radius: 3px; letter-spacing: 0.08em; font-size: 11pt; transform: rotate(-3deg); }
    .stamp--due { border-color: #B3261E; color: #B3261E; }
  `;
}

function masthead(property, docTitle, subtitle) {
  const logo = property.logo ? `<img class="masthead__logo" src="${escapeHtml(property.logo)}" alt="" />` : '';
  const meta = [
    [property.address, property.city].filter(Boolean).join(', '),
    [property.phone && 'Ph: ' + property.phone, property.whatsapp && 'WhatsApp: ' + property.whatsapp].filter(Boolean).join('  ·  '),
    property.email
  ].filter(Boolean).map(escapeHtml).join('<br>');

  return `<div class="masthead">
    ${logo}
    <div>
      <div class="masthead__name">${escapeHtml(property.name || 'Property')}</div>
      <div class="masthead__meta">${meta}</div>
    </div>
    <div class="masthead__right">
      <div class="masthead__doc">${escapeHtml(docTitle)}</div>
      ${subtitle ? `<div class="masthead__sub">${subtitle}</div>` : ''}
    </div>
  </div>`;
}

function wrap(css, body, title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title || 'Print')}</title><style>${css}</style></head><body>${body}</body></html>`;
}

function fmtCell(value, column, currency) {
  if (column.format === 'money') return formatMoney(value, currency);
  if (column.format === 'percent') return String(value) + '%';
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

/* --------------------------------------------------------------- reports */

/**
 * Any report from src/domain/reports.js. Columns wider than ~9 switch the
 * sheet to landscape so the guest register does not compress into unreadable
 * columns.
 */
export function reportDocument(store, report, opts) {
  const o = opts || {};
  const s = printerSettings(store);
  const property = store.property;
  const currency = property.currency || 'Rs';
  const landscape = o.landscape !== undefined ? o.landscape : report.columns.length > 9;

  const rowsPerPage = landscape ? ROWS_PER_PAGE : ROWS_FIRST_PAGE;
  const pages = [];
  if (report.rows.length === 0) pages.push([]);
  else {
    let i = 0;
    pages.push(report.rows.slice(0, rowsPerPage));
    i = rowsPerPage;
    while (i < report.rows.length) {
      pages.push(report.rows.slice(i, i + ROWS_PER_PAGE));
      i += ROWS_PER_PAGE;
    }
  }

  const rangeText = report.range
    ? `${formatDate(report.range.from)} — ${formatDate(report.range.to)}`
    : 'All records';

  const head = `<tr>${report.columns.map(c =>
    `<th class="${c.align === 'end' || c.format === 'money' || c.format === 'percent' ? 'n' : ''}">${escapeHtml(c.label)}</th>`).join('')}</tr>`;

  const totalsRow = report.totals && Object.keys(report.totals).length
    ? `<tfoot><tr>${report.columns.map((c, idx) => {
        if (idx === 0) return `<td>Total</td>`;
        const v = report.totals[c.key];
        if (v === undefined) return '<td></td>';
        return `<td class="n">${escapeHtml(fmtCell(v, c, currency))}</td>`;
      }).join('')}</tr></tfoot>`
    : '';

  const sheets = pages.map((rows, pageIndex) => {
    const body = rows.length
      ? rows.map(r => `<tr>${report.columns.map(c => {
          const raw = typeof c.value === 'function' ? c.value(r) : r[c.key];
          const numeric = c.align === 'end' || c.format === 'money' || c.format === 'percent';
          // Dates must not break across lines in a squeezed print column.
          const cls = numeric ? 'n' : (/date|check|^in$|^out$/i.test(c.key) ? 'd' : '');
          return `<td class="${cls}">${escapeHtml(fmtCell(raw, c, currency))}</td>`;
        }).join('')}</tr>`).join('')
      : `<tr><td colspan="${report.columns.length}" style="text-align:center;padding:26px;color:#6B7280">No records in this period.</td></tr>`;

    const isLast = pageIndex === pages.length - 1;

    return `<div class="sheet">
      ${masthead(property, report.title, report.titleUr ? `<span style="font-family:'Noto Nastaliq Urdu',serif">${escapeHtml(report.titleUr)}</span>` : '')}
      <div class="meta-row">
        <div><b>Period</b>${escapeHtml(rangeText)}</div>
        <div><b>Generated</b>${escapeHtml(formatDateTime(nowIso()))}</div>
        <div><b>Records</b>${report.rows.length}</div>
        <div><b>Prepared by</b>${escapeHtml(store.session.name || '—')}</div>
      </div>
      <table class="grid"><thead>${head}</thead><tbody>${body}</tbody>${isLast ? totalsRow : ''}</table>
      ${isLast && report.summary && report.summary.length ? `<div class="summary">${report.summary.map(item =>
        `<div class="summary__item"><div class="summary__label">${escapeHtml(item.label)}</div><div class="summary__value">${escapeHtml(item.format === 'money' ? formatMoney(item.value, currency) : String(item.value))}</div></div>`
      ).join('')}</div>` : ''}
      <div class="pagefoot">
        <span>${escapeHtml(property.name || '')} · ${escapeHtml(report.title)}</span>
        <span>Page ${pageIndex + 1} of ${pages.length}</span>
      </div>
    </div>`;
  }).join('');

  return wrap(a4Css(s.a4MarginMm, landscape), sheets, report.title);
}

/* --------------------------------------------------------------- invoice */

export function invoiceDocument(store, ctx) {
  const s = printerSettings(store);
  const property = store.property;
  const currency = property.currency || 'Rs';
  const money = v => formatMoney(v, currency);
  const { reservation, guest, unit, bill } = ctx;
  const settled = bill.balance <= 0;

  const rows = bill.lines.map(l => `<tr>
    <td>${escapeHtml(formatDate(l.date))}</td>
    <td>${escapeHtml(l.description)}</td>
    <td class="n">${escapeHtml(String(l.qty))}</td>
    <td class="n">${escapeHtml(money(l.rate))}</td>
    <td class="n">${escapeHtml(money(l.amount))}</td>
  </tr>`).join('');

  const paymentRows = (bill.payments || []).map(p => `<tr>
    <td>${escapeHtml(formatDate(String(p.at).slice(0, 10)))}</td>
    <td>${escapeHtml(p.code)}</td>
    <td>${escapeHtml(methodName(p.method))}${p.kind === 'refund' ? ' <em>(refund)</em>' : ''}</td>
    <td>${escapeHtml(p.reference || '—')}</td>
    <td class="n">${escapeHtml((p.kind === 'refund' ? '− ' : '') + money(p.amount))}</td>
  </tr>`).join('');

  const cnic = guest && guest.cnic
    ? (store.session.can('guest.viewCnic') ? guest.cnic : maskCnic(guest.cnic))
    : (guest && guest.passport ? guest.passport : '');

  const body = `<div class="sheet">
    ${masthead(property, 'Invoice', `No. <b>${escapeHtml(ctx.invoiceNo || reservation.code)}</b>`)}

    <div class="meta-row">
      <div><b>Invoice no</b>${escapeHtml(ctx.invoiceNo || '—')}</div>
      <div><b>Booking no</b>${escapeHtml(reservation.code)}</div>
      ${reservation.registerNo ? `<div><b>Register no</b>${escapeHtml(reservation.registerNo)}</div>` : ''}
      <div><b>Issued</b>${escapeHtml(formatDateTime(ctx.issuedAt || nowIso()))}</div>
    </div>

    <div class="inv-parties">
      <div>
        <h4>Billed to</h4>
        <div class="line">
          <b>${escapeHtml(guest ? guest.fullName : '—')}</b><br>
          ${guest && guest.fatherName ? escapeHtml('S/O ' + guest.fatherName) + '<br>' : ''}
          ${cnic ? 'CNIC / Passport: ' + escapeHtml(cnic) + '<br>' : ''}
          ${guest && guest.phone ? 'Phone: ' + escapeHtml(guest.phone) + '<br>' : ''}
          ${guest && [guest.address, guest.city].filter(Boolean).length ? escapeHtml([guest.address, guest.city].filter(Boolean).join(', ')) : ''}
        </div>
      </div>
      <div>
        <h4>Stay details</h4>
        <div class="line">
          ${escapeHtml(store.unitWord())}: <b>${escapeHtml(unit ? unit.code : '—')}</b><br>
          Check-in: ${escapeHtml(formatDate(reservation.checkIn))} ${escapeHtml(property.checkInTime || '')}<br>
          Check-out: ${escapeHtml(formatDate(reservation.checkOut))} ${escapeHtml(property.checkOutTime || '')}<br>
          Nights: ${escapeHtml(String(reservation.nights))} &nbsp;·&nbsp;
          Guests: ${escapeHtml(String(reservation.adults))} adult${reservation.adults === 1 ? '' : 's'}${reservation.children ? ', ' + reservation.children + ' child' + (reservation.children === 1 ? '' : 'ren') : ''}
        </div>
      </div>
      <div style="flex:0 0 auto;text-align:right">
        <div class="stamp ${settled ? '' : 'stamp--due'}">${settled ? 'PAID' : 'BALANCE DUE'}</div>
      </div>
    </div>

    <table class="grid">
      <thead><tr><th>Date</th><th>Description</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="inv-totals">
      <div class="row"><span>Subtotal</span><span class="v">${escapeHtml(money(bill.gross))}</span></div>
      ${bill.discount > 0 ? `<div class="row"><span>${escapeHtml(bill.discountLabel || 'Discount')}</span><span class="v">− ${escapeHtml(money(bill.discount))}</span></div>` : ''}
      ${bill.taxAmount > 0 ? `<div class="row"><span>${escapeHtml(bill.tax.name)} ${escapeHtml(String(bill.tax.percent))}%</span><span class="v">${escapeHtml(money(bill.taxAmount))}</span></div>` : ''}
      <div class="row grand"><span>Grand total</span><span class="v">${escapeHtml(money(bill.total))}</span></div>
      <div class="row rule"><span>Advance / paid</span><span class="v">${escapeHtml(money(bill.paid))}</span></div>
      <div class="row ${settled ? '' : 'due'}"><span><b>Balance</b></span><span class="v">${escapeHtml(money(bill.balance))}</span></div>
    </div>
    <div style="clear:both"></div>
    <div class="words">Amount in words: ${escapeHtml(amountInWords(bill.total))}</div>

    ${paymentRows ? `<div style="margin-top:16px">
      <h4 style="font-size:8pt;text-transform:uppercase;letter-spacing:0.06em;color:#6B7280;margin-bottom:5px">Payments received</h4>
      <table class="grid">
        <thead><tr><th>Date</th><th>Receipt</th><th>Method</th><th>Reference</th><th class="n">Amount</th></tr></thead>
        <tbody>${paymentRows}</tbody>
      </table>
    </div>` : ''}

    <div class="sign"><div>Guest signature</div><div>For ${escapeHtml(property.name || 'the property')}</div></div>

    ${property.invoiceFooter ? `<div class="notefoot">${escapeHtml(property.invoiceFooter)}</div>` : ''}
    <div class="pagefoot">
      <span>${escapeHtml(property.name || '')} · Invoice ${escapeHtml(ctx.invoiceNo || reservation.code)}</span>
      <span>Generated ${escapeHtml(formatDateTime(nowIso()))} · Page 1 of 1</span>
    </div>
  </div>`;

  return wrap(a4Css(s.a4MarginMm, false), body, 'Invoice ' + (ctx.invoiceNo || reservation.code));
}

/** The registration card kept on file — A4, with the accompanying-guest table. */
export function registrationCard(store, ctx) {
  const s = printerSettings(store);
  const property = store.property;
  const { reservation, guest, unit } = ctx;

  const companions = (reservation.companions || []).map((c, i) => `<tr>
    <td class="n">${i + 1}</td><td>${escapeHtml(c.name || '')}</td>
    <td>${escapeHtml(c.relation || '—')}</td><td class="n">${escapeHtml(c.age || '—')}</td>
    <td>${escapeHtml(c.gender || '—')}</td><td>${escapeHtml(c.cnic || '—')}</td>
  </tr>`).join('');

  const field = (label, value) =>
    `<div style="flex:1;min-width:160px"><b style="display:block;font-size:7.5pt;text-transform:uppercase;letter-spacing:0.06em;color:#6B7280">${escapeHtml(label)}</b><span style="font-size:10pt">${escapeHtml(value || '—')}</span></div>`;

  const body = `<div class="sheet">
    ${masthead(property, 'Guest Registration', `Register no. <b>${escapeHtml(reservation.registerNo || reservation.code)}</b>`)}
    <div class="meta-row" style="border-bottom:1px solid #E2E6E4;padding-bottom:10px">
      ${field('Booking no', reservation.code)}
      ${field('Arrival', formatDate(reservation.checkIn))}
      ${field('Departure', formatDate(reservation.checkOut))}
      ${field('Nights', String(reservation.nights))}
      ${field(store.unitWord(), unit ? unit.code : '—')}
    </div>

    <h4 style="margin:14px 0 7px;font-size:8.5pt;text-transform:uppercase;letter-spacing:0.06em;color:#6B7280">Principal guest</h4>
    <div style="display:flex;gap:18px;flex-wrap:wrap;row-gap:12px">
      ${field('Full name', guest ? guest.fullName : '')}
      ${field('Father / husband name', guest ? guest.fatherName : '')}
      ${field('CNIC / Passport', guest ? (guest.cnic || guest.passport) : '')}
      ${field('Phone', guest ? guest.phone : '')}
      ${field('Address', guest ? guest.address : '')}
      ${field('City', guest ? guest.city : '')}
      ${field('Country', guest ? guest.country : '')}
      ${field('Coming from', reservation.comingFrom)}
      ${field('Going to', reservation.goingTo)}
      ${field('Vehicle no', reservation.vehicleNo)}
      ${field('Purpose of visit', reservation.purpose)}
      ${field('Adults / Children', `${reservation.adults} / ${reservation.children}`)}
    </div>

    ${companions ? `<h4 style="margin:18px 0 7px;font-size:8.5pt;text-transform:uppercase;letter-spacing:0.06em;color:#6B7280">Accompanying persons</h4>
    <table class="grid"><thead><tr><th class="n">#</th><th>Name</th><th>Relation</th><th class="n">Age</th><th>Gender</th><th>CNIC / Passport</th></tr></thead>
    <tbody>${companions}</tbody></table>` : ''}

    <div style="margin-top:18px;padding:10px 12px;border:1px solid #E2E6E4;border-radius:4px;font-size:8.5pt;color:#4A5560;line-height:1.55">
      I confirm that the information given above is correct. I accept responsibility for the ${escapeHtml(store.unitWord().toLowerCase())}
      and its contents for the duration of my stay, and agree to settle all charges before departure.
      Check-out time is ${escapeHtml(property.checkOutTime || '12:00')}.
    </div>

    <div class="sign"><div>Guest signature</div><div>Reception</div></div>
    <div class="pagefoot">
      <span>${escapeHtml(property.name || '')} · Registration ${escapeHtml(reservation.registerNo || reservation.code)}</span>
      <span>Generated ${escapeHtml(formatDateTime(nowIso()))} · Page 1 of 1</span>
    </div>
  </div>`;

  return wrap(a4Css(s.a4MarginMm, false), body, 'Registration ' + reservation.code);
}

/** Day close — the sheet the owner signs. */
export function dayCloseDocument(store, ctx) {
  const s = printerSettings(store);
  const property = store.property;
  const currency = property.currency || 'Rs';
  const money = v => formatMoney(v, currency);
  const f = ctx.figures;

  const methodRows = f.byMethod.map(m => `<tr>
    <td>${escapeHtml(m.label)}</td>
    <td class="n">${escapeHtml(money(m.received))}</td>
    <td class="n">${escapeHtml(m.refunded ? '− ' + money(m.refunded) : '—')}</td>
    <td class="n">${escapeHtml(money(m.received - m.refunded))}</td>
  </tr>`).join('');

  const expenseRows = (ctx.expenses || []).map(e => `<tr>
    <td>${escapeHtml(e.code || '')}</td><td>${escapeHtml(e.category)}</td>
    <td>${escapeHtml(e.description)}</td><td>${escapeHtml(methodName(e.method))}</td>
    <td class="n">${escapeHtml(money(e.amount))}</td>
  </tr>`).join('');

  const body = `<div class="sheet">
    ${masthead(property, 'Day Close Report', escapeHtml(formatDate(f.date)))}
    <div class="meta-row">
      <div><b>Business date</b>${escapeHtml(formatDate(f.date))}</div>
      <div><b>Status</b>${f.locked ? 'Closed' : 'Open (provisional)'}</div>
      <div><b>Closed by</b>${escapeHtml(ctx.closedBy || store.session.name || '—')}</div>
      <div><b>Generated</b>${escapeHtml(formatDateTime(nowIso()))}</div>
    </div>

    <h4 style="margin:6px 0 6px;font-size:8.5pt;text-transform:uppercase;letter-spacing:0.06em;color:#6B7280">Collection by method</h4>
    <table class="grid">
      <thead><tr><th>Method</th><th class="n">Received</th><th class="n">Refunded</th><th class="n">Net</th></tr></thead>
      <tbody>${methodRows}</tbody>
      <tfoot><tr><td>Total</td><td class="n">${escapeHtml(money(f.received))}</td><td class="n">${escapeHtml(money(f.refunded))}</td><td class="n">${escapeHtml(money(f.netCollection))}</td></tr></tfoot>
    </table>

    ${expenseRows ? `<h4 style="margin:16px 0 6px;font-size:8.5pt;text-transform:uppercase;letter-spacing:0.06em;color:#6B7280">Expenses</h4>
    <table class="grid">
      <thead><tr><th>No</th><th>Category</th><th>Description</th><th>Method</th><th class="n">Amount</th></tr></thead>
      <tbody>${expenseRows}</tbody>
      <tfoot><tr><td colspan="4">Total expenses</td><td class="n">${escapeHtml(money(f.expenseTotal))}</td></tr></tfoot>
    </table>` : ''}

    <div class="inv-totals" style="width:330px">
      <div class="row"><span>Opening cash</span><span class="v">${escapeHtml(money(f.openingBalance))}</span></div>
      <div class="row"><span>Cash received</span><span class="v">${escapeHtml(money((f.byMethod.find(m => m.id === 'cash') || {}).received || 0))}</span></div>
      <div class="row"><span>Cash expenses</span><span class="v">− ${escapeHtml(money(f.expenseCash))}</span></div>
      <div class="row grand"><span>Closing cash</span><span class="v">${escapeHtml(money(f.closingCash))}</span></div>
      <div class="row rule"><span>Net collection</span><span class="v">${escapeHtml(money(f.netCollection))}</span></div>
      <div class="row due"><span>Outstanding dues</span><span class="v">${escapeHtml(money(f.outstanding))}</span></div>
    </div>
    <div style="clear:both"></div>

    <div class="summary">
      <div class="summary__item"><div class="summary__label">Arrivals</div><div class="summary__value">${f.arrivals}</div></div>
      <div class="summary__item"><div class="summary__label">Departures</div><div class="summary__value">${f.departures}</div></div>
      <div class="summary__item"><div class="summary__label">Occupied</div><div class="summary__value">${f.occupied} / ${f.available}</div></div>
      <div class="summary__item"><div class="summary__label">Occupancy</div><div class="summary__value">${f.occupancy}%</div></div>
      <div class="summary__item"><div class="summary__label">Room revenue</div><div class="summary__value">${escapeHtml(money(f.roomRevenue))}</div></div>
    </div>

    ${ctx.notes ? `<div class="notefoot"><b>Notes:</b> ${escapeHtml(ctx.notes)}</div>` : ''}
    <div class="sign"><div>Prepared by</div><div>Approved by</div></div>
    <div class="pagefoot">
      <span>${escapeHtml(property.name || '')} · Day close ${escapeHtml(f.date)}</span>
      <span>Page 1 of 1</span>
    </div>
  </div>`;

  return wrap(a4Css(s.a4MarginMm, false), body, 'Day close ' + f.date);
}
