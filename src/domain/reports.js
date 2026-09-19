/**
 * Reporting.
 *
 * Every report returns the same shape — { title, range, columns, rows, totals,
 * summary } — so one table renderer, one CSV exporter and one A4 print layout
 * serve all of them (requirement 26).
 */

import { toMoney } from '../core/money.js';
import { today, inRange, dateOfIso, formatDate, formatDateTime, eachDay, nightsList, presetRange } from '../core/dates.js';
import { billFor, paidTotal } from './folio.js';
import { listPayments, collectionBreakdown, outstanding } from './payments.js';
import { listExpenses, totalsByCategory } from './expenses.js';
import { listReservations, arrivalsOn, departuresOn } from './reservations.js';
import { listUnits } from './units.js';
import { methodName } from './payments.js';
import { sourceLabel, reservationStatusOf } from '../core/schema.js';

const money = v => toMoney(v);

function guestName(store, id) {
  const g = store.db.get('guests', id);
  return g ? g.fullName : '—';
}
function unitCode(store, id) {
  const u = store.db.get('units', id);
  return u ? u.code : '—';
}

/* ------------------------------------------------------------------ reports */

export function occupancyReport(store, from, to) {
  const units = listUnits(store);
  const sellable = units.filter(u => u.status !== 'maintenance' && u.status !== 'blocked').length || units.length;
  const dates = eachDay(from, to, 400);
  const active = store.db.all('reservations').filter(r =>
    !r.archivedAt && ['checked_in', 'checked_out', 'reserved'].indexOf(r.status) > -1);

  const rows = dates.map(date => {
    const sold = active.filter(r => r.checkIn <= date && r.checkOut > date).length;
    const revenue = active
      .filter(r => r.checkIn <= date && r.checkOut > date)
      .reduce((sum, r) => {
        const snap = r.rateSnapshot;
        const night = snap && Array.isArray(snap.nights) ? snap.nights.find(n => n.date === date) : null;
        return sum + money(night ? night.rate : r.rate);
      }, 0);
    return {
      date,
      dateLabel: formatDate(date),
      available: sellable,
      sold,
      free: Math.max(0, sellable - sold),
      occupancy: sellable ? Math.round(sold * 1000 / sellable) / 10 : 0,
      revenue,
      adr: sold ? Math.round(revenue / sold) : 0,
      revpar: sellable ? Math.round(revenue / sellable) : 0
    };
  });

  const totalSold = rows.reduce((s, r) => s + r.sold, 0);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const capacity = sellable * rows.length;

  return {
    id: 'occupancy',
    title: 'Occupancy report',
    range: { from, to },
    columns: [
      { key: 'dateLabel', label: 'Date' },
      { key: 'available', label: 'Units', align: 'end' },
      { key: 'sold', label: 'Sold', align: 'end' },
      { key: 'free', label: 'Free', align: 'end' },
      { key: 'occupancy', label: 'Occupancy %', align: 'end', format: 'percent' },
      { key: 'adr', label: 'ADR', align: 'end', format: 'money' },
      { key: 'revpar', label: 'RevPAR', align: 'end', format: 'money' },
      { key: 'revenue', label: 'Room revenue', align: 'end', format: 'money' }
    ],
    rows,
    totals: { sold: totalSold, revenue: totalRevenue },
    summary: [
      { label: 'Unit nights available', value: capacity },
      { label: 'Unit nights sold', value: totalSold },
      { label: 'Occupancy', value: capacity ? (Math.round(totalSold * 1000 / capacity) / 10) + '%' : '0%' },
      { label: 'ADR', value: totalSold ? Math.round(totalRevenue / totalSold) : 0, format: 'money' },
      { label: 'RevPAR', value: capacity ? Math.round(totalRevenue / capacity) : 0, format: 'money' },
      { label: 'Room revenue', value: totalRevenue, format: 'money' }
    ]
  };
}

export function arrivalsReport(store, from, to) {
  const rows = [];
  for (const date of eachDay(from, to, 400)) {
    arrivalsOn(store, date).forEach(r => rows.push({
      date, dateLabel: formatDate(date), code: r.code, guest: guestName(store, r.guestId),
      unit: unitCode(store, r.unitId), nights: r.nights, adults: r.adults, children: r.children,
      source: sourceLabel(r.source), status: reservationStatusOf(r.status).label,
      total: billFor(store, r).total
    }));
  }
  return {
    id: 'arrivals', title: 'Arrival report', range: { from, to },
    columns: [
      { key: 'dateLabel', label: 'Date' }, { key: 'code', label: 'Booking' },
      { key: 'guest', label: 'Guest' }, { key: 'unit', label: 'Unit' },
      { key: 'nights', label: 'Nights', align: 'end' }, { key: 'adults', label: 'Adults', align: 'end' },
      { key: 'children', label: 'Children', align: 'end' }, { key: 'source', label: 'Source' },
      { key: 'status', label: 'Status' }, { key: 'total', label: 'Bill', align: 'end', format: 'money' }
    ],
    rows,
    totals: { total: rows.reduce((s, r) => s + r.total, 0) },
    summary: [
      { label: 'Arrivals', value: rows.length },
      { label: 'Guests', value: rows.reduce((s, r) => s + r.adults + r.children, 0) }
    ]
  };
}

export function departuresReport(store, from, to) {
  const rows = [];
  for (const date of eachDay(from, to, 400)) {
    departuresOn(store, date).forEach(r => {
      const bill = billFor(store, r);
      rows.push({
        date, dateLabel: formatDate(date), code: r.code, guest: guestName(store, r.guestId),
        unit: unitCode(store, r.unitId), nights: r.nights,
        total: bill.total, paid: bill.paid, balance: bill.balance,
        status: reservationStatusOf(r.status).label, invoice: r.invoiceNo || '—'
      });
    });
  }
  return {
    id: 'departures', title: 'Departure report', range: { from, to },
    columns: [
      { key: 'dateLabel', label: 'Date' }, { key: 'code', label: 'Booking' },
      { key: 'guest', label: 'Guest' }, { key: 'unit', label: 'Unit' },
      { key: 'nights', label: 'Nights', align: 'end' }, { key: 'invoice', label: 'Invoice' },
      { key: 'total', label: 'Total', align: 'end', format: 'money' },
      { key: 'paid', label: 'Paid', align: 'end', format: 'money' },
      { key: 'balance', label: 'Balance', align: 'end', format: 'money' },
      { key: 'status', label: 'Status' }
    ],
    rows,
    totals: {
      total: rows.reduce((s, r) => s + r.total, 0),
      paid: rows.reduce((s, r) => s + r.paid, 0),
      balance: rows.reduce((s, r) => s + r.balance, 0)
    },
    summary: [{ label: 'Departures', value: rows.length }]
  };
}

export function bookingsReport(store, from, to, opts) {
  const o = opts || {};
  let list = store.db.all('reservations').filter(r => !r.archivedAt && inRange(dateOfIso(r.createdAt), from, to));
  if (o.status) list = list.filter(r => r.status === o.status);

  const rows = list.map(r => {
    const bill = billFor(store, r);
    return {
      code: r.code, created: formatDate(dateOfIso(r.createdAt)),
      guest: guestName(store, r.guestId), unit: unitCode(store, r.unitId),
      checkIn: formatDate(r.checkIn), checkOut: formatDate(r.checkOut), nights: r.nights,
      source: sourceLabel(r.source), status: reservationStatusOf(r.status).label,
      total: bill.total, paid: bill.paid, balance: bill.balance
    };
  }).sort((a, b) => String(a.code).localeCompare(String(b.code)));

  return {
    id: 'bookings', title: o.status === 'cancelled' ? 'Cancelled bookings' : 'Booking report', range: { from, to },
    columns: [
      { key: 'code', label: 'Booking' }, { key: 'created', label: 'Booked on' },
      { key: 'guest', label: 'Guest' }, { key: 'unit', label: 'Unit' },
      { key: 'checkIn', label: 'Check-in' }, { key: 'checkOut', label: 'Check-out' },
      { key: 'nights', label: 'Nt', align: 'end' }, { key: 'source', label: 'Source' },
      { key: 'status', label: 'Status' }, { key: 'total', label: 'Total', align: 'end', format: 'money' },
      { key: 'balance', label: 'Balance', align: 'end', format: 'money' }
    ],
    rows,
    totals: { total: rows.reduce((s, r) => s + r.total, 0), balance: rows.reduce((s, r) => s + r.balance, 0) },
    summary: [{ label: 'Bookings', value: rows.length }]
  };
}

export function revenueReport(store, from, to) {
  const stays = store.db.all('reservations').filter(r =>
    !r.archivedAt && ['checked_in', 'checked_out'].indexOf(r.status) > -1 &&
    nightsList(r.checkIn, r.checkOut).some(d => inRange(d, from, to)));

  const byCategory = new Map();
  let roomRevenue = 0;
  for (const r of stays) {
    const bill = billFor(store, r);
    for (const line of bill.lines) {
      if (!inRange(line.date, from, to) && line.category !== 'room') continue;
      const key = line.category || 'custom';
      byCategory.set(key, (byCategory.get(key) || 0) + money(line.amount));
      if (key === 'room') roomRevenue += money(line.amount);
    }
  }

  const rows = Array.from(byCategory.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  const collection = collectionBreakdown(store, from, to);
  const expenses = totalsByCategory(store, from, to);
  const total = rows.reduce((s, r) => s + r.amount, 0);

  return {
    id: 'revenue', title: 'Revenue report', range: { from, to },
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'amount', label: 'Amount', align: 'end', format: 'money' }
    ],
    rows,
    totals: { amount: total },
    summary: [
      { label: 'Room revenue', value: roomRevenue, format: 'money' },
      { label: 'Total revenue', value: total, format: 'money' },
      { label: 'Collected', value: collection.net, format: 'money' },
      { label: 'Expenses', value: expenses.total, format: 'money' },
      { label: 'Net cash', value: collection.net - expenses.total, format: 'money' }
    ]
  };
}

export function paymentsReport(store, from, to, opts) {
  const list = listPayments(store, Object.assign({ from, to }, opts || {}));
  const rows = list.map(p => ({
    code: p.code, at: formatDateTime(p.at), date: dateOfIso(p.at),
    guest: guestName(store, p.guestId),
    booking: p.reservationId ? (store.db.get('reservations', p.reservationId) || {}).code || '—' : '—',
    method: methodName(p.method), kind: p.kind,
    reference: p.reference || '—',
    amount: p.kind === 'refund' ? -money(p.amount) : money(p.amount),
    user: (store.db.get('users', p.userId) || {}).name || '—'
  }));
  const breakdown = collectionBreakdown(store, from, to);
  return {
    id: 'payments', title: 'Payment report', range: { from, to },
    columns: [
      { key: 'code', label: 'Receipt' }, { key: 'at', label: 'Date / time' },
      { key: 'guest', label: 'Guest' }, { key: 'booking', label: 'Booking' },
      { key: 'method', label: 'Method' }, { key: 'kind', label: 'Type' },
      { key: 'reference', label: 'Reference' },
      { key: 'amount', label: 'Amount', align: 'end', format: 'money' }
    ],
    rows,
    totals: { amount: rows.reduce((s, r) => s + r.amount, 0) },
    summary: Object.keys(breakdown.byMethod)
      .filter(m => breakdown.byMethod[m] !== 0)
      .map(m => ({ label: methodName(m), value: breakdown.byMethod[m], format: 'money' }))
      .concat([{ label: 'Net collection', value: breakdown.net, format: 'money' }])
  };
}

export function outstandingReport(store) {
  const list = outstanding(store);
  const rows = list.map(o => ({
    code: o.reservation.code,
    guest: o.guest ? o.guest.fullName : '—',
    phone: o.guest ? o.guest.phone : '—',
    unit: o.unit ? o.unit.code : '—',
    checkIn: formatDate(o.reservation.checkIn),
    checkOut: formatDate(o.reservation.checkOut),
    status: reservationStatusOf(o.reservation.status).label,
    total: o.bill.total, paid: o.bill.paid, balance: o.balance
  }));
  return {
    id: 'outstanding', title: 'Outstanding report', range: null,
    columns: [
      { key: 'code', label: 'Booking' }, { key: 'guest', label: 'Guest' },
      { key: 'phone', label: 'Phone' }, { key: 'unit', label: 'Unit' },
      { key: 'checkIn', label: 'Check-in' }, { key: 'checkOut', label: 'Check-out' },
      { key: 'status', label: 'Status' },
      { key: 'total', label: 'Total', align: 'end', format: 'money' },
      { key: 'paid', label: 'Paid', align: 'end', format: 'money' },
      { key: 'balance', label: 'Balance', align: 'end', format: 'money' }
    ],
    rows,
    totals: { balance: rows.reduce((s, r) => s + r.balance, 0) },
    summary: [
      { label: 'Guests owing', value: rows.length },
      { label: 'Total outstanding', value: rows.reduce((s, r) => s + r.balance, 0), format: 'money' }
    ]
  };
}

export function expensesReport(store, from, to) {
  const { list, rows: byCat, total } = totalsByCategory(store, from, to);
  const rows = list.map(e => ({
    code: e.code, date: formatDate(e.date), category: e.category,
    description: e.description, paidTo: e.paidTo || '—',
    method: methodName(e.method), amount: money(e.amount)
  }));
  return {
    id: 'expenses', title: 'Expense report', range: { from, to },
    columns: [
      { key: 'code', label: 'No' }, { key: 'date', label: 'Date' },
      { key: 'category', label: 'Category' }, { key: 'description', label: 'Description' },
      { key: 'paidTo', label: 'Paid to' }, { key: 'method', label: 'Method' },
      { key: 'amount', label: 'Amount', align: 'end', format: 'money' }
    ],
    rows,
    totals: { amount: total },
    summary: byCat.map(c => ({ label: c.category, value: c.amount, format: 'money' }))
      .concat([{ label: 'Total expenses', value: total, format: 'money' }])
  };
}

export function guestHistoryReport(store, from, to) {
  const list = store.db.all('reservations').filter(r => !r.archivedAt && inRange(r.checkIn, from, to));
  const byGuest = new Map();
  for (const r of list) {
    const key = r.guestId;
    if (!byGuest.has(key)) byGuest.set(key, { guestId: key, visits: 0, nights: 0, total: 0, paid: 0 });
    const g = byGuest.get(key);
    const bill = billFor(store, r);
    g.visits += 1;
    g.nights += Number(r.nights) || 0;
    g.total += bill.total;
    g.paid += bill.paid;
  }
  const rows = Array.from(byGuest.values()).map(g => {
    const guest = store.db.get('guests', g.guestId);
    return {
      guest: guest ? guest.fullName : '—',
      phone: guest ? guest.phone : '—',
      city: guest ? guest.city : '—',
      visits: g.visits, nights: g.nights,
      total: g.total, paid: g.paid, balance: g.total - g.paid
    };
  }).sort((a, b) => b.total - a.total);

  return {
    id: 'guests', title: 'Guest history report', range: { from, to },
    columns: [
      { key: 'guest', label: 'Guest' }, { key: 'phone', label: 'Phone' }, { key: 'city', label: 'City' },
      { key: 'visits', label: 'Visits', align: 'end' }, { key: 'nights', label: 'Nights', align: 'end' },
      { key: 'total', label: 'Charges', align: 'end', format: 'money' },
      { key: 'paid', label: 'Paid', align: 'end', format: 'money' },
      { key: 'balance', label: 'Balance', align: 'end', format: 'money' }
    ],
    rows,
    totals: { total: rows.reduce((s, r) => s + r.total, 0), paid: rows.reduce((s, r) => s + r.paid, 0) },
    summary: [{ label: 'Guests', value: rows.length }]
  };
}

export function unitPerformanceReport(store, from, to) {
  const units = listUnits(store);
  const nights = eachDay(from, to, 400).length;
  const rows = units.map(unit => {
    const stays = store.db.where('reservations', 'unitId', unit.id).filter(r =>
      !r.archivedAt && ['checked_in', 'checked_out'].indexOf(r.status) > -1);
    let sold = 0, revenue = 0;
    for (const r of stays) {
      const snap = r.rateSnapshot;
      for (const d of nightsList(r.checkIn, r.checkOut)) {
        if (!inRange(d, from, to)) continue;
        sold += 1;
        const night = snap && Array.isArray(snap.nights) ? snap.nights.find(n => n.date === d) : null;
        revenue += money(night ? night.rate : r.rate);
      }
    }
    return {
      unit: unit.code,
      type: (store.db.get('unitTypes', unit.unitTypeId) || {}).name || '—',
      floor: unit.floor || '—',
      sold, free: Math.max(0, nights - sold),
      occupancy: nights ? Math.round(sold * 1000 / nights) / 10 : 0,
      adr: sold ? Math.round(revenue / sold) : 0,
      revenue
    };
  }).sort((a, b) => b.revenue - a.revenue);

  return {
    id: 'units', title: 'Unit performance report', range: { from, to },
    columns: [
      { key: 'unit', label: 'Unit' }, { key: 'type', label: 'Type' }, { key: 'floor', label: 'Floor' },
      { key: 'sold', label: 'Nights sold', align: 'end' },
      { key: 'occupancy', label: 'Occupancy %', align: 'end', format: 'percent' },
      { key: 'adr', label: 'ADR', align: 'end', format: 'money' },
      { key: 'revenue', label: 'Revenue', align: 'end', format: 'money' }
    ],
    rows,
    totals: { revenue: rows.reduce((s, r) => s + r.revenue, 0), sold: rows.reduce((s, r) => s + r.sold, 0) },
    summary: [{ label: 'Units', value: rows.length }]
  };
}

/** The Pakistani guest register — the prototype's روزنامچہ, now live. */
export function registerReport(store, from, to, opts) {
  const o = opts || {};
  let list = store.db.all('reservations').filter(r =>
    !r.archivedAt && r.status !== 'cancelled' && r.status !== 'no_show' && inRange(r.checkIn, from, to));

  if (o.filter === 'in') list = list.filter(r => r.status === 'checked_in');
  else if (o.filter === 'out') list = list.filter(r => r.status === 'checked_out');
  else if (o.filter === 'pending') list = list.filter(r => billFor(store, r).balance > 0);
  else if (o.filter === 'cleared') list = list.filter(r => billFor(store, r).balance <= 0);

  const rows = list.map(r => {
    const guest = store.db.get('guests', r.guestId) || {};
    const bill = billFor(store, r);
    return {
      sno: r.registerNo || r.code,
      date: formatDate(r.checkIn),
      time: r.checkedInAt ? formatDateTime(r.checkedInAt).split(' · ')[1] : '—',
      guest: guest.fullName || '—',
      cnic: guest.cnic || guest.passport || '—',
      unit: unitCode(store, r.unitId),
      persons: (Number(r.adults) || 0) + (Number(r.children) || 0) + (r.companions || []).length,
      from: r.comingFrom || '—',
      to: r.goingTo || '—',
      vehicle: r.vehicleNo || '—',
      inAt: formatDate(r.checkIn),
      outAt: r.status === 'checked_out' ? formatDate(r.checkOut) : '—',
      charges: bill.total, paid: bill.paid, balance: bill.balance,
      cleared: bill.balance <= 0 ? 'Cleared' : 'Pending'
    };
  }).sort((a, b) => String(a.sno).localeCompare(String(b.sno)));

  return {
    id: 'register', title: 'Guest register', titleUr: 'روزنامچہ', range: { from, to },
    columns: [
      { key: 'sno', label: 'S.No' }, { key: 'date', label: 'Date' }, { key: 'time', label: 'Time' },
      { key: 'guest', label: 'Guest name' }, { key: 'cnic', label: 'CNIC' }, { key: 'unit', label: 'Unit' },
      { key: 'persons', label: 'Persons', align: 'end' }, { key: 'from', label: 'Coming from' },
      { key: 'to', label: 'Going to' }, { key: 'vehicle', label: 'Vehicle' },
      { key: 'inAt', label: 'In' }, { key: 'outAt', label: 'Out' },
      { key: 'charges', label: 'Charges', align: 'end', format: 'money' },
      { key: 'paid', label: 'Paid', align: 'end', format: 'money' },
      { key: 'balance', label: 'Balance', align: 'end', format: 'money' },
      { key: 'cleared', label: 'Cleared' }
    ],
    rows,
    totals: {
      charges: rows.reduce((s, r) => s + r.charges, 0),
      paid: rows.reduce((s, r) => s + r.paid, 0),
      balance: rows.reduce((s, r) => s + r.balance, 0)
    },
    summary: [
      { label: 'Entries', value: rows.length },
      { label: 'Guests', value: rows.reduce((s, r) => s + r.persons, 0) },
      { label: 'Total charges', value: rows.reduce((s, r) => s + r.charges, 0), format: 'money' },
      { label: 'Collected', value: rows.reduce((s, r) => s + r.paid, 0), format: 'money' },
      { label: 'Outstanding', value: rows.reduce((s, r) => s + r.balance, 0), format: 'money' }
    ]
  };
}

export function housekeepingReport(store, from, to) {
  const units = listUnits(store);
  const rows = units.map(u => {
    const task = store.db.all('housekeeping')
      .filter(t => t.unitId === u.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    return {
      unit: u.code,
      type: (store.db.get('unitTypes', u.unitTypeId) || {}).name || '—',
      floor: u.floor || '—',
      status: u.status,
      hkStatus: u.hkStatus,
      lastCleaned: task && task.completedAt ? formatDateTime(task.completedAt) : '—',
      by: task && task.completedBy ? ((store.db.get('users', task.completedBy) || {}).name || '—') : '—'
    };
  });
  return {
    id: 'housekeeping', title: 'Housekeeping report', range: { from, to },
    columns: [
      { key: 'unit', label: 'Unit' }, { key: 'type', label: 'Type' }, { key: 'floor', label: 'Floor' },
      { key: 'status', label: 'Status' }, { key: 'hkStatus', label: 'Housekeeping' },
      { key: 'lastCleaned', label: 'Last cleaned' }, { key: 'by', label: 'By' }
    ],
    rows,
    totals: {},
    summary: [
      { label: 'Ready', value: rows.filter(r => r.hkStatus === 'clean' || r.hkStatus === 'inspected').length },
      { label: 'Dirty', value: rows.filter(r => r.hkStatus === 'dirty').length },
      { label: 'Being cleaned', value: rows.filter(r => r.hkStatus === 'cleaning').length }
    ]
  };
}

export const REPORTS = [
  { id: 'register',    label: 'Guest register',    build: registerReport },
  { id: 'occupancy',   label: 'Occupancy',         build: occupancyReport },
  { id: 'arrivals',    label: 'Arrivals',          build: arrivalsReport },
  { id: 'departures',  label: 'Departures',        build: departuresReport },
  { id: 'bookings',    label: 'Bookings',          build: bookingsReport },
  { id: 'cancelled',   label: 'Cancelled bookings', build: (s, f, t) => bookingsReport(s, f, t, { status: 'cancelled' }) },
  { id: 'revenue',     label: 'Revenue',           build: revenueReport },
  { id: 'payments',    label: 'Payments',          build: paymentsReport },
  { id: 'outstanding', label: 'Outstanding',       build: (s) => outstandingReport(s) },
  { id: 'expenses',    label: 'Expenses',          build: expensesReport },
  { id: 'guests',      label: 'Guest history',     build: guestHistoryReport },
  { id: 'units',       label: 'Unit performance',  build: unitPerformanceReport },
  { id: 'housekeeping', label: 'Housekeeping',     build: housekeepingReport }
];

export function buildReport(store, id, from, to, opts) {
  const spec = REPORTS.find(r => r.id === id) || REPORTS[0];
  return spec.build(store, from || today(), to || today(), opts);
}

export { presetRange };
