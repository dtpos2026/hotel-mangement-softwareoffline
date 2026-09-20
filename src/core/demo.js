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
import { saveCategory, saveMenuItem, saveTable, openOrder, addLine, sendToKitchen } from '../domain/restaurant.js';
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
    ['101', standard, 'Ground floor', '1 double'],
    ['102', standard, 'Ground floor', '2 single'],
    ['103', standard, 'Ground floor', '1 double'],
    ['104', standard, 'Ground floor', '2 single'],
    ['105', deluxe, 'Ground floor', '1 king'],
    ['106', deluxe, 'Ground floor', '1 double + 1 single'],
    ['201', deluxe, 'First floor', '1 king'],
    ['202', deluxe, 'First floor', '1 double + 1 single'],
    ['203', deluxe, 'First floor', '1 queen'],
    ['204', deluxe, 'First floor', '1 double + 1 single'],
    ['205', family, 'First floor', '2 double + 1 single'],
    ['206', family, 'First floor', '1 double + 1 bunk'],
    ['301', family, 'Second floor', '2 double + 1 sofa'],
    ['302', family, 'Second floor', '1 king + 2 single'],
    ['Cottage 07', cottage, 'Garden', '2 double + 2 single'],
    ['Cottage 08', cottage, 'Garden', '3 double + 1 bunk']
  ];

  const units = {};
  for (const [code, type, floor, bedConfig] of unitSpecs) {
    units[code] = await saveUnit(store, {
      code, unitTypeId: type.id, floor,
      capacityAdults: type.capacityAdults, capacityChildren: type.capacityChildren,
      baseRate: type.defaultRate, weekendRate: type.weekendRate,
      extraBedCharge: type.extraBedCharge, amenities: type.amenities,
      bedConfig
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

  /* The restaurant, switched on so the module can be seen. A property that
     does not want it turns it off in Settings and the nav entry disappears. */
  await store.updateSetting('restaurant', { enabled: true, serviceChargePercent: 0 });

  const catFood = await saveCategory(store, { name: 'Food', nameUr: 'کھانا', sortOrder: 1 });
  const catBbq = await saveCategory(store, { name: 'BBQ', nameUr: 'باربی کیو', sortOrder: 2 });
  const catDrinks = await saveCategory(store, { name: 'Drinks', nameUr: 'مشروبات', sortOrder: 3 });
  const catBreakfast = await saveCategory(store, { name: 'Breakfast', nameUr: 'ناشتہ', sortOrder: 4 });

  const menu = [
    ['F01', 'Trout Fish', 'ٹراؤٹ مچھلی', catFood, 2650],
    ['F02', 'Chicken Karahi', 'چکن کڑاہی', catFood, 1850],
    ['F03', 'Mutton Karahi', 'مٹن کڑاہی', catFood, 2400],
    ['F04', 'Daal Mash', 'دال ماش', catFood, 650],
    ['F05', 'Mixed Vegetable', 'مکس سبزی', catFood, 550],
    ['F06', 'Roti', 'روٹی', catFood, 30],
    ['F07', 'Naan', 'نان', catFood, 60],
    ['B01', 'Chapli Kabab', 'چپلی کباب', catBbq, 900],
    ['B02', 'Seekh Kabab', 'سیخ کباب', catBbq, 750],
    ['B03', 'Chicken Tikka', 'چکن تکہ', catBbq, 850],
    ['D01', 'Chai', 'چائے', catDrinks, 150],
    ['D02', 'Kashmiri Chai', 'کشمیری چائے', catDrinks, 250],
    ['D03', 'Fresh Lime', 'تازہ لیموں', catDrinks, 200],
    ['D04', 'Mineral Water', 'منرل واٹر', catDrinks, 100],
    ['K01', 'Halwa Puri', 'حلوہ پوری', catBreakfast, 450],
    ['K02', 'Omelette', 'آملیٹ', catBreakfast, 300],
    ['K03', 'Paratha', 'پراٹھا', catBreakfast, 120]
  ];
  const menuItems = {};
  for (const [code, name, nameUr, cat, price] of menu) {
    menuItems[code] = await saveMenuItem(store, { code, name, nameUr, categoryId: cat.id, price });
  }

  const tableSpecs = [
    ['1', 4, 'Main hall', 'square'], ['2', 2, 'Main hall', 'square'],
    ['3', 6, 'Main hall', 'rect'],   ['4', 4, 'Main hall', 'round'],
    ['5', 4, 'Main hall', 'square'], ['6', 8, 'Main hall', 'rect'],
    ['L1', 6, 'Lawn', 'round'],      ['L2', 6, 'Lawn', 'round'],
    ['L3', 4, 'Lawn', 'square'],     ['T1', 2, 'Terrace', 'square'],
    ['T2', 2, 'Terrace', 'square']
  ];
  const tables = {};
  for (const [code, seats, area, shape] of tableSpecs) {
    tables[code] = await saveTable(store, { code, seats, area, shape });
  }

  // One table mid-service and one waiting for its bill, so the floor plan is
  // not a wall of empty squares on the first run.
  const lunch = await openOrder(store, { type: 'table', tableId: tables['3'].id, covers: 5, waiter: 'Imran' });
  await addLine(store, lunch.id, { menuItemId: menuItems.F01.id, qty: 2 });
  await addLine(store, lunch.id, { menuItemId: menuItems.B01.id, qty: 3 });
  await addLine(store, lunch.id, { menuItemId: menuItems.F06.id, qty: 8 });
  await addLine(store, lunch.id, { menuItemId: menuItems.D01.id, qty: 5, notes: 'less sugar' });
  await sendToKitchen(store, lunch.id);

  const tea = await openOrder(store, { type: 'table', tableId: tables.L1.id, covers: 2, waiter: 'Shahid' });
  await addLine(store, tea.id, { menuItemId: menuItems.D02.id, qty: 2 });
  await addLine(store, tea.id, { menuItemId: menuItems.K03.id, qty: 2 });

  await store.updateSetting('app', { demoDataLoaded: true });
  await store.db.flush();
}
