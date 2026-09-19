/**
 * Everything the reception dashboard shows, computed in one pass so the screen
 * never walks the collections itself (requirement 4 and 35).
 */

import { today, formatDate, nightsBetween } from '../core/dates.js';
import { toMoney } from '../core/money.js';
import { listUnits, countByStatus } from './units.js';
import { arrivalsOn, departuresOn, inHouse, overdue, listReservations } from './reservations.js';
import { billFor } from './folio.js';
import { collectionBreakdown, outstanding } from './payments.js';
import { readyCount } from './housekeeping.js';
import { dayFigures } from './daily.js';

export function dashboardData(store, date) {
  const d = date || today();
  const units = listUnits(store);
  const byStatus = countByStatus(store);

  const arrivals = arrivalsOn(store, d).map(r => decorate(store, r));
  const departures = departuresOn(store, d).map(r => decorate(store, r));
  const occupied = inHouse(store).map(r => decorate(store, r));
  const late = overdue(store, d).map(r => decorate(store, r));

  const collection = collectionBreakdown(store, d, d);
  const dues = outstanding(store);
  const outstandingTotal = dues.reduce((s, o) => s + o.balance, 0);

  // What tonight's confirmed occupancy is worth, at frozen rates.
  const expectedRevenue = listReservations(store)
    .filter(r => ['reserved', 'checked_in'].indexOf(r.status) > -1 && r.checkIn <= d && r.checkOut > d)
    .reduce((sum, r) => {
      const snap = r.rateSnapshot;
      const night = snap && Array.isArray(snap.nights) ? snap.nights.find(n => n.date === d) : null;
      return sum + toMoney(night ? night.rate : r.rate);
    }, 0);

  const sellable = units.filter(u => u.status !== 'maintenance' && u.status !== 'blocked').length || units.length;
  const occupancy = sellable ? Math.round(occupied.length * 1000 / sellable) / 10 : 0;

  return {
    date: d,
    dateLabel: formatDate(d),
    totals: {
      units: units.length,
      available: byStatus.available || 0,
      reserved: byStatus.reserved || 0,
      occupied: byStatus.occupied || 0,
      cleaning: byStatus.cleaning || 0,
      maintenance: byStatus.maintenance || 0,
      blocked: byStatus.blocked || 0,
      ready: readyCount(store)
    },
    occupancy,
    arrivals,
    departures,
    occupiedList: occupied,
    overdueList: late,
    expectedRevenue,
    collection: collection.net,
    collectionByMethod: collection.byMethod,
    outstanding: outstandingTotal,
    outstandingCount: dues.length,
    figures: dayFigures(store, d, { live: true }),
    recent: recentActivity(store, 8)
  };
}

function decorate(store, reservation) {
  const guest = store.db.get('guests', reservation.guestId);
  const unit = store.db.get('units', reservation.unitId);
  const bill = billFor(store, reservation);
  return {
    reservation, guest, unit, bill,
    guestName: guest ? guest.fullName : 'Unknown guest',
    unitCode: unit ? unit.code : '—',
    phone: guest ? guest.phone : '',
    balance: bill.balance,
    nightsLeft: Math.max(0, nightsBetween(today(), reservation.checkOut)),
    overdue: reservation.status === 'checked_in' && reservation.checkOut < today()
  };
}

/** The prototype's "Recent register entries" panel, now built from real data. */
export function recentActivity(store, limit) {
  const events = [];

  for (const r of store.db.all('reservations')) {
    if (r.archivedAt) continue;
    if (r.checkedInAt) events.push({ at: r.checkedInAt, kind: 'In', reservation: r });
    if (r.checkedOutAt) events.push({ at: r.checkedOutAt, kind: 'Out', reservation: r });
  }
  for (const p of store.db.all('payments')) {
    if (p.voided) continue;
    events.push({ at: p.at, kind: p.kind === 'refund' ? 'Refund' : 'Payment', payment: p });
  }

  return events
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit || 10)
    .map(e => {
      const r = e.reservation || (e.payment && e.payment.reservationId ? store.db.get('reservations', e.payment.reservationId) : null);
      const guest = store.db.get('guests', (e.payment && e.payment.guestId) || (r && r.guestId));
      const unit = r ? store.db.get('units', r.unitId) : null;
      return {
        at: e.at,
        kind: e.kind,
        sno: r ? (r.registerNo || r.code) : (e.payment ? e.payment.code : ''),
        guest: guest ? guest.fullName : '—',
        unit: unit ? unit.code : '—',
        amount: e.payment ? toMoney(e.payment.amount) : (r ? billFor(store, r).total : 0),
        reservationId: r ? r.id : ''
      };
    });
}
