/**
 * Sample data for the first run.
 *
 * Kept deliberately small and realistic — a Swat guest house with four floors
 * of mixed units — so every screen has something meaningful in it on day one
 * without pretending to be a year of history. It is written through the normal
 * domain services, so nothing here can create a record the app itself could not.
 */

import { saveUnitType, saveUnit } from '../domain/units.js';
import { saveGuest } from '../domain/guests.js';
import { createReservation } from '../domain/reservations.js';
import { checkIn, checkOut } from '../domain/stays.js';
import { addCharge } from '../domain/folio.js';
import { recordPayment } from '../domain/payments.js';
import { recordExpense } from '../domain/expenses.js';
import { setHkStatus } from '../domain/housekeeping.js';
import { today, addDays } from './dates.js';

export async function seedDemoData(store) {
  const d = today();

  /* Unit types — deliberately spanning rooms, a cottage and an apartment, so
     the generic PROPERTY -> UNIT TYPE -> UNIT model is visible from the start. */
  const standard = await saveUnitType(store, {
    name: 'Standard Double', capacityAdults: 2, capacityChildren: 1,
    defaultRate: 6000, weekendRate: 7000, extraBedCharge: 1500,
    amenities: ['Geyser', 'TV', 'Heater']
  });
  const deluxe = await saveUnitType(store, {
    name: 'Deluxe Double', capacityAdults: 2, capacityChildren: 2,
    defaultRate: 8500, weekendRate: 9500, extraBedCharge: 1500,
    amenities: ['Geyser', 'TV', 'Heater', 'Balcony', 'River view']
  });
  const family = await saveUnitType(store, {
    name: 'Family Suite', capacityAdults: 4, capacityChildren: 2,
    defaultRate: 14000, weekendRate: 16000, extraBedCharge: 2000,
    amenities: ['Geyser', 'TV', 'Heater', 'Lounge', 'Kitchenette']
  });
  const cottage = await saveUnitType(store, {
    name: 'Cottage', capacityAdults: 6, capacityChildren: 2,
    defaultRate: 20000, weekendRate: 24000, extraBedCharge: 2500,
    amenities: ['Private lawn', 'Kitchen', 'Heater', 'Parking']
  });

  const unitSpecs = [
    ['101', standard, 'Ground floor'], ['102', standard, 'Ground floor'],
    ['103', standard, 'Ground floor'], ['104', standard, 'Ground floor'],
    ['105', deluxe, 'Ground floor'], ['106', deluxe, 'Ground floor'],
    ['201', deluxe, 'First floor'], ['202', deluxe, 'First floor'],
    ['203', deluxe, 'First floor'], ['204', deluxe, 'First floor'],
    ['205', family, 'First floor'], ['206', family, 'First floor'],
    ['301', family, 'Second floor'], ['302', family, 'Second floor'],
    ['Cottage 07', cottage, 'Garden'], ['Cottage 08', cottage, 'Garden']
  ];

  const units = {};
  for (const [code, type, floor] of unitSpecs) {
    units[code] = await saveUnit(store, {
      code, unitTypeId: type.id, floor,
      capacityAdults: type.capacityAdults, capacityChildren: type.capacityChildren,
      baseRate: type.defaultRate, weekendRate: type.weekendRate,
      extraBedCharge: type.extraBedCharge, amenities: type.amenities,
      bedConfig: type.capacityAdults > 2 ? '2 double + 1 single' : '1 double'
    });
  }

  const guestSpecs = [
    ['Muhammad Bilal', 'Abdul Rahman', '15302-1234567-1', '0300-1234567', 'Lahore'],
    ['Ayesha Khan', 'Tariq Khan', '35202-9988771-4', '0321-8899001', 'Lahore'],
    ['Zahid Ullah', 'Noor Ullah', '17301-4455662-9', '0345-7712345', 'Mardan'],
    ['Sardar Ali', 'Ghulam Ali', '15602-1122334-7', '0301-4455667', 'Karachi'],
    ['Farhan Malik', 'Iqbal Malik', '61101-2233445-1', '0333-4412200', 'Islamabad'],
    ['Noreen Baig', 'Sher Baig', '15302-7766554-3', '0312-9988776', 'Peshawar']
  ];

  const guests = {};
  for (const [fullName, fatherName, cnic, phone, city] of guestSpecs) {
    guests[fullName] = await saveGuest(store, {
      fullName, fatherName, cnic, phone, whatsapp: phone, city, country: 'Pakistan',
      address: `${city}`, guestType: 'individual'
    });
  }

  /* Three guests in house, with different money positions so the dashboard,
     the folio and the outstanding report all have something real to show. */

  // Settled stay.
  const r1 = await createReservation(store, {
    guestId: guests['Ayesha Khan'].id, unitId: units['301'].id,
    checkIn: addDays(d, -1), checkOut: addDays(d, 2),
    adults: 2, children: 2, source: 'phone',
    comingFrom: 'Lahore', goingTo: 'Naran', vehicleNo: 'LEA-7788',
    companions: [{ name: 'Hina Khan', relation: 'Daughter', age: '9' }]
  });
  await checkIn(store, r1.id, {});
  await recordPayment(store, { reservationId: r1.id, guestId: r1.guestId, amount: 44100, method: 'bank', kind: 'payment' });

  // Stay with a running balance and extras on the folio.
  const r2 = await createReservation(store, {
    guestId: guests['Muhammad Bilal'].id, unitId: units['204'].id,
    checkIn: addDays(d, -2), checkOut: d,
    adults: 2, children: 1, extraBeds: 1, discount: 750, source: 'walkin',
    comingFrom: 'Islamabad', goingTo: 'Kalam', vehicleNo: 'LEB-1234',
    companions: [
      { name: 'Sana Bilal', relation: 'Wife', age: '31' },
      { name: 'Hamza Bilal', relation: 'Son', age: '7' }
    ]
  });
  await checkIn(store, r2.id, { advance: 10000, paymentMethod: 'cash' });
  await addCharge(store, r2.id, { category: 'food', description: 'Trout fish, Chapli Kabab, Roti', qty: 1, rate: 2650 });
  await addCharge(store, r2.id, { category: 'food', description: 'Chai', qty: 4, rate: 150 });
  await addCharge(store, r2.id, { category: 'laundry', description: 'Laundry', qty: 3, rate: 150 });

  // Longer stay, part paid.
  const r3 = await createReservation(store, {
    guestId: guests['Sardar Ali'].id, unitId: units['Cottage 07'].id,
    checkIn: addDays(d, -3), checkOut: addDays(d, 3),
    adults: 5, children: 1, source: 'agent',
    comingFrom: 'Karachi', goingTo: 'Hunza', vehicleNo: 'AJK-9090'
  });
  await checkIn(store, r3.id, { advance: 60000, paymentMethod: 'easypaisa' });

  // A completed stay, so there is an invoice and register history.
  const r4 = await createReservation(store, {
    guestId: guests['Farhan Malik'].id, unitId: units['105'].id,
    checkIn: addDays(d, -4), checkOut: addDays(d, -1),
    adults: 2, children: 0, source: 'whatsapp',
    comingFrom: 'Islamabad', goingTo: 'Kalam', vehicleNo: 'ISB-3344'
  });
  await checkIn(store, r4.id, { advance: 15000, paymentMethod: 'cash' });
  await checkOut(store, r4.id, { payment: 10500, paymentMethod: 'cash', acceptBalance: true });

  // Future bookings, so the calendar and arrivals list are not empty.
  await createReservation(store, {
    guestId: guests['Noreen Baig'].id, unitId: units['202'].id,
    checkIn: d, checkOut: addDays(d, 2),
    adults: 2, children: 0, source: 'phone',
    comingFrom: 'Peshawar', goingTo: 'Kalam', notes: 'ETA 6:00 PM'
  });
  await createReservation(store, {
    guestId: guests['Zahid Ullah'].id, unitId: units['101'].id,
    checkIn: addDays(d, 1), checkOut: addDays(d, 3),
    adults: 2, children: 0, source: 'walkin',
    comingFrom: 'Mardan', goingTo: 'Swat', vehicleNo: 'MRD-2211'
  });

  // A couple of units mid-cycle so housekeeping has a real queue.
  await setHkStatus(store, units['103'].id, 'dirty');
  await setHkStatus(store, units['206'].id, 'dirty');
  await setHkStatus(store, units['206'].id, 'cleaning');

  await recordExpense(store, { date: d, category: 'Electricity', description: 'WAPDA bill', amount: 12000, method: 'cash', paidTo: 'WAPDA' });
  await recordExpense(store, { date: d, category: 'Supplies', description: 'Towels and soap', amount: 3500, method: 'cash', paidTo: 'Swat Traders' });
  await recordExpense(store, { date: addDays(d, -1), category: 'Staff salary', description: 'Housekeeping advance', amount: 8000, method: 'cash' });

  await store.updateSetting('app', { demoDataLoaded: true });
  await store.db.flush();
}
