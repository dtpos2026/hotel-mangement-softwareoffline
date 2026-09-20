/**
 * The bridge between screens and the print renderers.
 *
 * Every printable thing is available three ways — Print, Preview and (from
 * preview) Open in a new window — because reception needs to check a receipt
 * before burning paper, and because a driver that swallows the print dialog
 * still leaves the new-window escape hatch.
 */

import { h, mount } from './dom.js';
import { modal, fail, ok as toastOk } from './feedback.js';
import { segmented } from './components.js';
import { openDocument, printerSettings } from '../print/printer.js';
import * as host from '../core/host.js';
import * as r80 from '../print/receipt80.js';
import * as a4 from '../print/a4.js';
import { billFor } from '../domain/folio.js';
import { billFor as restaurantBill } from '../domain/restaurant.js';
import { dayFigures } from '../domain/daily.js';
import { listExpenses } from '../domain/expenses.js';

/** Preview modal with a live, scrollable rendering of the real document. */
export function preview(store, opts) {
  const o = opts || {};
  let mode = o.mode || printerSettings(store).mode;
  const frameHolder = h('div', {
    style: {
      background: 'var(--surface-sunk)', border: '1px solid var(--line)', borderRadius: 'var(--r)',
      padding: '16px', display: 'flex', justifyContent: 'center', minHeight: '320px', overflow: 'auto'
    }
  });

  const draw = () => {
    const html = o.build(mode);
    const frame = h('iframe', {
      title: 'Print preview',
      style: {
        width: o.wide ? '210mm' : '80mm',
        minHeight: o.wide ? '297mm' : '420px',
        border: '0', background: '#fff',
        boxShadow: '0 2px 14px rgba(22,32,42,0.14)'
      }
    });
    mount(frameHolder, frame);
    const doc = frame.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    // Grow the frame to fit a receipt of any length.
    setTimeout(() => {
      try {
        const height = doc.body.scrollHeight;
        if (height) frame.style.height = (height + 24) + 'px';
      } catch { /* cross-document access can fail; the min-height covers it */ }
    }, 120);
  };

  const dialog = modal({
    title: o.title || 'Print preview',
    subtitle: o.subtitle,
    size: o.wide ? 'xwide' : 'wide',
    body: h('div.stack', [
      o.showModes !== false ? h('div.row', [
        h('span.filters__label', { text: 'Mode' }),
        segmented({
          options: [{ value: 'normal', label: 'Normal' }, { value: 'compact', label: 'Compact — save paper' }],
          value: mode, onChange: v => { mode = v; draw(); }
        }),
        h('span.push.text-xs.text-muted', { text: geometryNote(store) })
      ]) : h('div.text-xs.text-muted', { text: 'A4 · ' + printerSettings(store).a4MarginMm + 'mm margins' }),
      frameHolder
    ]),
    footer: [
      h('button.btn', { type: 'button', text: 'Open in new window',
        onclick: () => { try { openDocument(o.build(mode)); } catch (err) { fail(err); } } }),
      h('button.btn', { type: 'button', text: 'Close', onclick: () => dialog.close() }),
      h('button.btn.btn--primary', { type: 'button', text: 'Print',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.classList.add('is-busy'); btn.disabled = true;
          try {
            await printNow(store, o.build(mode), { wide: o.wide });
            dialog.close();
          } catch (err) {
            fail(err, 'Could not print');
            btn.classList.remove('is-busy'); btn.disabled = false;
          }
        } })
    ]
  });
  draw();
  return dialog;
}

function geometryNote(store) {
  const s = printerSettings(store);
  const area = s.widthMm - s.marginLeftMm - s.marginRightMm;
  return `${s.widthMm}mm paper · ${area}mm print area`;
}

/**
 * Prints with the saved geometry.
 *
 * On the desktop the page is set to a continuous roll of the configured width,
 * so a thermal driver does not pad an 80mm receipt out to A4, and the job can
 * go straight to the chosen printer with no dialog. In a browser neither is
 * possible, so it falls back to the hidden-iframe print path.
 */
export async function printNow(store, html, opts) {
  const o = opts || {};
  const s = printerSettings(store);
  const job = { copies: s.copies };

  if (host.isDesktop) {
    job.printerName = s.printerName || '';
    job.silent = !!s.silentPrint && !!job.printerName;
    if (o.wide) {
      job.pageSize = 'A4';
      job.landscape = !!o.landscape;
    } else {
      job.widthMm = s.widthMm;
      job.heightMm = 2000;      // a long roll; the driver cuts at the content
    }
  }

  await host.printDocument(html, job);
}

function ctxFor(store, reservation, opts) {
  const bill = billFor(store, reservation, { live: !reservation.invoiceNo });
  return Object.assign({
    reservation,
    guest: store.db.get('guests', reservation.guestId),
    unit: store.db.get('units', reservation.unitId),
    bill,
    invoiceNo: reservation.invoiceNo || '',
    issuedAt: bill.issuedAt || '',
    servedBy: store.session.name
  }, opts || {});
}

/* ----------------------------------------------------------- 80mm actions */

export function printBill(store, reservation, opts) {
  const ctx = ctxFor(store, reservation, opts);
  return preview(store, {
    title: 'Guest bill — 80mm',
    subtitle: `${reservation.code}${reservation.invoiceNo ? ' · invoice ' + reservation.invoiceNo : ''}`,
    build: mode => r80.guestBill(store, Object.assign({}, ctx, { mode }))
  });
}

export function printCheckInSlip(store, reservation) {
  const ctx = ctxFor(store, reservation);
  return preview(store, {
    title: 'Check-in slip — 80mm',
    subtitle: reservation.code,
    build: mode => r80.checkInSlip(store, Object.assign({}, ctx, { mode }))
  });
}

export function printPaymentReceipt(store, payment) {
  const reservation = payment.reservationId ? store.db.get('reservations', payment.reservationId) : null;
  const bill = reservation ? billFor(store, reservation) : null;
  const ctx = {
    payment,
    guest: store.db.get('guests', payment.guestId),
    reservation,
    unit: reservation ? store.db.get('units', reservation.unitId) : null,
    balanceAfter: bill ? bill.balance : null,
    servedBy: store.session.name
  };
  return preview(store, {
    title: 'Payment receipt — 80mm',
    subtitle: payment.code,
    build: mode => r80.paymentReceipt(store, Object.assign({}, ctx, { mode }))
  });
}

export function printDaySlip(store, date, figures) {
  const f = figures || dayFigures(store, date, { live: true });
  return preview(store, {
    title: 'Day close — 80mm',
    subtitle: f.date,
    build: mode => r80.dayCloseSlip(store, { figures: f, closedBy: store.session.name, mode })
  });
}

/** Kitchen slip for the items just sent. */
export function printKitchenSlip(store, order, lines) {
  const where = orderWhere(store, order);
  const ctx = { order, lines, where };
  // The kitchen slip goes straight to the printer when a printer is set:
  // nobody wants a preview between the order and the cook.
  const s = printerSettings(store);
  if (host.isDesktop && s.printerName && s.silentPrint) {
    return printNow(store, r80.kitchenSlip(store, Object.assign({}, ctx, { mode: s.mode })))
      .then(() => toastOk('Kitchen slip printed'))
      .catch(err => fail(err, 'Could not print the kitchen slip'));
  }
  return preview(store, {
    title: 'Kitchen slip',
    subtitle: `${order.code} · ${lines.length} item(s)`,
    build: mode => r80.kitchenSlip(store, Object.assign({}, ctx, { mode }))
  });
}

export function printOrderBill(store, order) {
  const bill = restaurantBill(store, order);
  const ctx = { order, bill, where: orderWhere(store, order), paymentMethod: order.paymentMethod };
  return preview(store, {
    title: 'Restaurant bill — 80mm',
    subtitle: order.code,
    build: mode => r80.orderBill(store, Object.assign({}, ctx, { mode }))
  });
}

function orderWhere(store, order) {
  if (order.type === 'table') {
    const table = store.db.get('tables', order.tableId);
    return table ? 'Table ' + table.code : 'Table';
  }
  if (order.type === 'room') {
    const stay = store.db.get('reservations', order.reservationId);
    const unit = stay ? store.db.get('units', stay.unitId) : null;
    return unit ? 'Room ' + unit.code : 'Room';
  }
  return 'Takeaway';
}

export function printTestPage(store) {
  return preview(store, {
    title: 'Printer test page',
    subtitle: 'Check that the paper images edge to edge.',
    build: mode => r80.testPrint(store, mode)
  });
}

/**
 * The sample bill from the design picker, on real paper.
 *
 * It takes the design being previewed rather than the saved one, so a design
 * can be tried on the actual printer before it is committed to.
 */
export function printSample(store, opts) {
  const o = opts || {};
  return preview(store, {
    title: 'Receipt design sample',
    subtitle: 'Sample figures — nothing is recorded.',
    build: mode => r80.sampleReceipt(store, { template: o.template, mode })
  });
}

/* ------------------------------------------------------------- A4 actions */

export function printInvoice(store, reservation) {
  const ctx = ctxFor(store, reservation);
  return preview(store, {
    title: 'Invoice — A4',
    subtitle: reservation.invoiceNo || reservation.code,
    wide: true, showModes: false,
    build: () => a4.invoiceDocument(store, ctx)
  });
}

export function printRegistrationCard(store, reservation) {
  const ctx = ctxFor(store, reservation);
  return preview(store, {
    title: 'Registration card — A4',
    subtitle: reservation.registerNo || reservation.code,
    wide: true, showModes: false,
    build: () => a4.registrationCard(store, ctx)
  });
}

export function printReport(store, report) {
  return preview(store, {
    title: report.title + ' — A4',
    subtitle: report.range ? `${report.range.from} to ${report.range.to}` : 'All records',
    wide: true, showModes: false,
    build: () => a4.reportDocument(store, report)
  });
}

export function printDayCloseA4(store, date, figures, notes) {
  const f = figures || dayFigures(store, date, { live: true });
  return preview(store, {
    title: 'Day close report — A4',
    subtitle: f.date,
    wide: true, showModes: false,
    build: () => a4.dayCloseDocument(store, {
      figures: f,
      expenses: listExpenses(store, { from: f.date, to: f.date }),
      closedBy: store.session.name,
      notes
    })
  });
}
