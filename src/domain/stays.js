/**
 * Check-in, check-out, walk-in and unit moves.
 *
 * Check-out is the moment a stay's money stops being editable: an invoice
 * record is written holding a full snapshot of the bill, the reservation points
 * at it by number, and from then on billFor() serves the frozen copy.
 */

import { newId, nextSequence, takenSet } from '../core/ids.js';
import { nowIso, today, nightsBetween, addDays } from '../core/dates.js';
import { toMoney } from '../core/money.js';
import { createReservation, assertAvailable, releaseUnitIfIdle, quoteFor } from './reservations.js';
import { saveGuest } from './guests.js';
import { billFor } from './folio.js';
import { recordPayment } from './payments.js';
import { capacityOf } from './units.js';

/**
 * Moves a reservation into the unit.
 * Anything already in the unit is a hard stop — the board must match reality.
 */
export async function checkIn(store, reservationId, opts) {
  store.session.require('stay.checkin');
  const o = opts || {};
  const reservation = store.db.get('reservations', reservationId);
  if (!reservation) throw new Error('Booking not found.');
  if (reservation.status === 'checked_in') throw new Error('This guest is already checked in.');
  if (reservation.status !== 'reserved') throw new Error('Only a booking with status "Reserved" can be checked in.');

  const unitId = o.unitId || reservation.unitId;
  const unit = store.db.get('units', unitId);
  if (!unit) throw new Error('That unit no longer exists.');
  if (unit.status === 'occupied') throw new Error(`${unit.code} is still occupied. Check the current guest out first.`);
  if (unit.status === 'maintenance' || unit.status === 'blocked') throw new Error(`${unit.code} is not available for guests.`);

  if (unitId !== reservation.unitId) assertAvailable(store, unitId, reservation.checkIn, reservation.checkOut, reservationId);

  const record = Object.assign({}, reservation, {
    unitId,
    unitTypeId: unit.unitTypeId,
    status: 'checked_in',
    checkedInAt: nowIso(),
    checkedInBy: store.session.id,
    adults: o.adults !== undefined ? Number(o.adults) : reservation.adults,
    children: o.children !== undefined ? Number(o.children) : reservation.children,
    companions: Array.isArray(o.companions) ? o.companions.filter(c => c && c.name) : reservation.companions,
    notes: o.notes !== undefined ? o.notes : reservation.notes
  });

  await store.write('stay.checkin', (tx, log) => {
    tx.put('reservations', record);
    tx.put('units', Object.assign({}, unit, { status: 'occupied' }));
    if (unitId !== reservation.unitId) releaseUnitIfIdle(tx, store, reservation.unitId, reservationId);
    log('reservations', reservationId, { code: reservation.code, unit: unit.code });
  });

  if (toMoney(o.advance) > 0) {
    await recordPayment(store, {
      reservationId, guestId: record.guestId, amount: o.advance,
      method: o.paymentMethod || 'cash', kind: 'advance', notes: 'Advance at check-in'
    });
  }

  return record;
}

/**
 * The fast reception path (requirement 11): guest, unit, dates, rate, advance
 * and check-in in one call, so the desk does not walk a queue through four
 * screens.
 */
export async function walkIn(store, input) {
  store.session.require('stay.checkin');

  const checkInDate = input.checkIn || today();
  const checkOutDate = input.checkOut;
  const unit = store.db.get('units', input.unitId);
  if (!unit) throw new Error('Choose a unit first.');
  if (unit.status === 'occupied') throw new Error(`${unit.code} is occupied.`);

  // Availability is asserted before a guest record is written, so a rejected
  // walk-in never leaves a stray profile behind.
  assertAvailable(store, input.unitId, checkInDate, checkOutDate, null);

  const guest = input.guestId
    ? store.db.get('guests', input.guestId)
    : await saveGuest(store, input.guest || {}, { requireCnic: store.setting('booking').requireCnic });
  if (!guest) throw new Error('Guest details are required.');

  const reservation = await createReservation(store, {
    guestId: guest.id,
    unitId: input.unitId,
    checkIn: checkInDate,
    checkOut: checkOutDate,
    adults: input.adults,
    children: input.children,
    rate: input.rate,
    discount: input.discount,
    discountType: input.discountType,
    extraBeds: input.extraBeds,
    extraBedCharge: input.extraBedCharge,
    extraPersonCharge: input.extraPersonCharge,
    source: input.source || 'walkin',
    notes: input.notes,
    companions: input.companions,
    comingFrom: input.comingFrom,
    goingTo: input.goingTo,
    vehicleNo: input.vehicleNo,
    purpose: input.purpose,
    allowOvercapacity: input.allowOvercapacity,
    status: 'reserved'
  });

  const checkedIn = await checkIn(store, reservation.id, {
    advance: input.advance,
    paymentMethod: input.paymentMethod
  });

  return { guest, reservation: checkedIn };
}

/** Moves a checked-in guest to another unit mid-stay. */
export async function changeUnit(store, reservationId, newUnitId, reason) {
  store.session.require('stay.changeUnit');
  const reservation = store.db.get('reservations', reservationId);
  if (!reservation) throw new Error('Booking not found.');
  if (reservation.status !== 'checked_in') throw new Error('Only a guest who is checked in can be moved.');

  const target = store.db.get('units', newUnitId);
  if (!target) throw new Error('That unit no longer exists.');
  if (target.id === reservation.unitId) return reservation;
  if (target.status === 'occupied') throw new Error(`${target.code} is occupied.`);

  // Only the remainder of the stay needs to be free.
  const from = today() > reservation.checkIn ? today() : reservation.checkIn;
  assertAvailable(store, newUnitId, from, reservation.checkOut, reservationId);

  const previous = store.db.get('units', reservation.unitId);
  const record = Object.assign({}, reservation, {
    unitId: newUnitId,
    unitTypeId: target.unitTypeId,
    movedFrom: (reservation.movedFrom || []).concat([{
      unitId: reservation.unitId, unitCode: previous ? previous.code : '',
      at: nowIso(), reason: String(reason || ''), by: store.session.id
    }])
  });

  await store.write('stay.changeUnit', (tx, log) => {
    tx.put('reservations', record);
    tx.put('units', Object.assign({}, target, { status: 'occupied' }));
    if (previous) tx.put('units', Object.assign({}, previous, { status: 'cleaning', hkStatus: 'dirty' }));
    log('reservations', reservationId, {
      code: reservation.code, from: previous ? previous.code : '', to: target.code, reason: String(reason || '')
    });
  });
  return record;
}

/** Extends or shortens a stay in place. Re-runs the availability guard. */
export async function changeDates(store, reservationId, checkOut) {
  store.session.require('reservation.edit');
  const reservation = store.db.get('reservations', reservationId);
  if (!reservation) throw new Error('Booking not found.');
  if (reservation.status !== 'checked_in' && reservation.status !== 'reserved') {
    throw new Error('Only an active booking can have its dates changed.');
  }
  if (checkOut <= reservation.checkIn) throw new Error('Check-out must be at least one night after check-in.');
  if (checkOut === reservation.checkOut) return reservation;

  if (checkOut > reservation.checkOut) {
    assertAvailable(store, reservation.unitId, reservation.checkOut, checkOut, reservationId);
  }

  // Extra nights price at the rate already frozen for this stay, not today's.
  const snap = reservation.rateSnapshot;
  let nextSnap = snap;
  if (snap && Array.isArray(snap.nights)) {
    const nights = [];
    let cursor = reservation.checkIn;
    while (cursor < checkOut) {
      const existing = snap.nights.find(n => n.date === cursor);
      nights.push(existing || { date: cursor, weekend: false, rate: snap.base });
      cursor = addDays(cursor, 1);
    }
    nextSnap = Object.assign({}, snap, { nights });
  }

  const record = Object.assign({}, reservation, {
    checkOut,
    nights: nightsBetween(reservation.checkIn, checkOut),
    rateSnapshot: nextSnap,
    updatedAt: nowIso()
  });

  await store.write('stay.changeDates', (tx, log) => {
    tx.put('reservations', record);
    log('reservations', reservationId, { code: reservation.code, from: reservation.checkOut, to: checkOut });
  });
  return record;
}

/**
 * Settles and closes a stay.
 *
 * An outstanding balance is allowed only when the settings permit it *and* the
 * signed-in role holds stay.checkoutWithBalance — requirement 15.
 */
export async function checkOut(store, reservationId, opts) {
  store.session.require('stay.checkout');
  const o = opts || {};
  const reservation = store.db.get('reservations', reservationId);
  if (!reservation) throw new Error('Booking not found.');
  if (reservation.status === 'checked_out') throw new Error('This stay is already closed.');
  if (reservation.status !== 'checked_in') throw new Error('Only a guest who is checked in can be checked out.');

  // Final payment first, so the invoice snapshot records the settled position.
  if (toMoney(o.payment) > 0) {
    await recordPayment(store, {
      reservationId, guestId: reservation.guestId, amount: o.payment,
      method: o.paymentMethod || 'cash', reference: o.reference, kind: 'payment', notes: 'Settlement at check-out'
    });
  }

  const bill = billFor(store, reservation, { live: true });
  const settings = store.setting('booking');

  if (bill.balance > 0) {
    if (!settings.allowCheckoutWithBalance) {
      const err = new Error(`Checkout balance pending: ${bill.balance}. Settings do not allow closing a stay with an outstanding balance.`);
      err.code = 'BALANCE_PENDING';
      err.balance = bill.balance;
      throw err;
    }
    if (!o.acceptBalance) {
      const err = new Error(`Checkout balance pending: ${bill.balance}.`);
      err.code = 'BALANCE_CONFIRM';
      err.balance = bill.balance;
      throw err;
    }
    store.session.require('stay.checkoutWithBalance');
  }

  const unit = store.db.get('units', reservation.unitId);
  const guest = store.db.get('guests', reservation.guestId);
  const counters = store.counters();
  const autoDirty = settings.autoDirtyOnCheckout !== false;
  let invoice, record;

  await store.write('stay.checkout', (tx, log) => {
    const no = nextSequence(tx, counters, 'invoice', { taken: takenSet(tx.all('invoices'), 'no') });

    // The snapshot: everything the invoice must still say in five years.
    invoice = {
      id: newId('inv'),
      no,
      reservationId,
      guestId: reservation.guestId,
      unitId: reservation.unitId,
      issuedAt: nowIso(),
      issuedBy: store.session.id,
      guestName: guest ? guest.fullName : '',
      guestCnic: guest ? guest.cnic : '',
      guestPhone: guest ? guest.phone : '',
      unitCode: unit ? unit.code : '',
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
      nights: reservation.nights,
      adults: reservation.adults,
      children: reservation.children,
      bill: {
        reservationId,
        lines: JSON.parse(JSON.stringify(bill.lines)),
        roomCharge: bill.roomCharge,
        gross: bill.gross,
        discount: bill.discount,
        discountLabel: bill.discountLabel,
        net: bill.net,
        tax: bill.tax,
        taxAmount: bill.taxAmount,
        total: bill.total,
        nights: bill.nights
      },
      totalAtIssue: bill.total,
      paidAtIssue: bill.paid,
      balanceAtIssue: bill.balance,
      voided: false
    };
    tx.put('invoices', invoice);

    record = Object.assign({}, reservation, {
      status: 'checked_out',
      checkedOutAt: nowIso(),
      checkedOutBy: store.session.id,
      invoiceNo: no,
      closingBalance: bill.balance
    });
    tx.put('reservations', record);

    if (unit) {
      tx.put('units', Object.assign({}, unit, {
        status: autoDirty ? 'cleaning' : 'available',
        hkStatus: autoDirty ? 'dirty' : unit.hkStatus
      }));
    }

    if (autoDirty && unit) {
      tx.put('housekeeping', {
        id: newId('hk'), unitId: unit.id, unitCode: unit.code, status: 'dirty',
        source: 'checkout', reservationId, assignedTo: '', notes: '',
        createdAt: nowIso(), startedAt: null, completedAt: null, date: today()
      });
    }

    log('reservations', reservationId, {
      code: reservation.code, invoice: no, total: bill.total, paid: bill.paid, balance: bill.balance
    });
  });

  return { reservation: record, invoice, bill };
}

/** Live settlement figures for the check-out screen, before anything is saved. */
export function settlementPreview(store, reservation) {
  const bill = billFor(store, reservation, { live: true });
  return {
    bill,
    quote: quoteFor(store, reservation),
    capacity: capacityOf(store, store.db.get('units', reservation.unitId)),
    overdue: reservation.checkOut < today(),
    extraNights: reservation.checkOut < today() ? nightsBetween(reservation.checkOut, today()) : 0
  };
}
