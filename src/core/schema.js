/**
 * Data model, defaults and migrations.
 *
 * The model is deliberately generic: PROPERTY -> UNIT TYPE -> UNIT. A unit is a
 * room, a cottage, an apartment, a villa or a bed. The UI says "Room" when the
 * property type calls for it, but nothing in storage assumes a hotel room.
 */

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = [
  'property',      // property profile (array of one today, many later)
  'unitTypes',
  'units',
  'guests',
  'reservations',
  'folioLines',
  'payments',
  'invoices',
  'housekeeping',  // housekeeping task log
  'maintenance',
  'expenses',
  'dayClosings',
  'users',
  'settings',      // singleton rows keyed by id
  'counters',      // sequence counters
  'auditLog'
];

/* ---------------------------------------------------------------- vocabulary */

export const PROPERTY_TYPES = [
  { id: 'hotel',      label: 'Hotel',       labelUr: 'ہوٹل',        unitWord: 'Room',      unitWordUr: 'کمرہ' },
  { id: 'guesthouse', label: 'Guest House', labelUr: 'گیسٹ ہاؤس',   unitWord: 'Room',      unitWordUr: 'کمرہ' },
  { id: 'resort',     label: 'Resort',      labelUr: 'ریزورٹ',      unitWord: 'Unit',      unitWordUr: 'یونٹ' },
  { id: 'apartment',  label: 'Apartments',  labelUr: 'اپارٹمنٹس',   unitWord: 'Apartment', unitWordUr: 'اپارٹمنٹ' },
  { id: 'villa',      label: 'Villas',      labelUr: 'ولاز',        unitWord: 'Villa',     unitWordUr: 'ولا' },
  { id: 'cottage',    label: 'Cottages',    labelUr: 'کاٹجز',       unitWord: 'Cottage',   unitWordUr: 'کاٹج' },
  { id: 'hostel',     label: 'Hostel',      labelUr: 'ہاسٹل',       unitWord: 'Bed',       unitWordUr: 'بستر' },
  { id: 'other',      label: 'Other',       labelUr: 'دیگر',        unitWord: 'Unit',      unitWordUr: 'یونٹ' }
];

/** Sellable state of a unit. Housekeeping state is tracked separately. */
export const UNIT_STATUS = [
  { id: 'available',   label: 'Available',   labelUr: 'دستیاب',   color: 'var(--ok)',      sellable: true },
  { id: 'reserved',    label: 'Reserved',    labelUr: 'محفوظ',    color: 'var(--accent)',  sellable: true },
  { id: 'occupied',    label: 'Occupied',    labelUr: 'مصروف',    color: 'var(--river)',   sellable: false },
  { id: 'cleaning',    label: 'Cleaning',    labelUr: 'صفائی',    color: 'var(--warn)',    sellable: true },
  { id: 'maintenance', label: 'Maintenance', labelUr: 'مرمت',     color: 'var(--muted)',   sellable: false },
  { id: 'blocked',     label: 'Blocked',     labelUr: 'بند',      color: 'var(--muted)',   sellable: false }
];

/** Housekeeping lifecycle: dirty -> cleaning -> clean -> inspected. */
export const HK_STATUS = [
  { id: 'clean',     label: 'Clean',     labelUr: 'صاف',      color: 'var(--ok)' },
  { id: 'dirty',     label: 'Dirty',     labelUr: 'گندا',     color: 'var(--warn)' },
  { id: 'cleaning',  label: 'Cleaning',  labelUr: 'صفائی',    color: 'var(--river)' },
  { id: 'inspected', label: 'Inspected', labelUr: 'معائنہ',   color: 'var(--deodar)' }
];

export const RESERVATION_STATUS = [
  { id: 'reserved',    label: 'Reserved',    labelUr: 'محفوظ',   color: 'var(--accent)', blocksInventory: true },
  { id: 'checked_in',  label: 'Checked in',  labelUr: 'آمد',     color: 'var(--river)',  blocksInventory: true },
  { id: 'checked_out', label: 'Checked out', labelUr: 'روانگی',  color: 'var(--muted)',  blocksInventory: false },
  { id: 'cancelled',   label: 'Cancelled',   labelUr: 'منسوخ',   color: 'var(--muted)',  blocksInventory: false },
  { id: 'no_show',     label: 'No-show',     labelUr: 'غیر حاضر', color: 'var(--due)',   blocksInventory: false }
];

export const BOOKING_SOURCES = [
  { id: 'walkin',   label: 'Walk-in',      labelUr: 'واک ان' },
  { id: 'phone',    label: 'Phone',        labelUr: 'فون' },
  { id: 'whatsapp', label: 'WhatsApp',     labelUr: 'واٹس ایپ' },
  { id: 'direct',   label: 'Direct',       labelUr: 'براہ راست' },
  { id: 'agent',    label: 'Travel Agent', labelUr: 'ٹریول ایجنٹ' },
  { id: 'group',    label: 'Tour Group',   labelUr: 'ٹور گروپ' },
  { id: 'other',    label: 'Other',        labelUr: 'دیگر' }
];

export const PAYMENT_METHODS = [
  { id: 'cash',      label: 'Cash',       labelUr: 'نقد' },
  { id: 'easypaisa', label: 'Easypaisa',  labelUr: 'ایزی پیسہ' },
  { id: 'jazzcash',  label: 'JazzCash',   labelUr: 'جاز کیش' },
  { id: 'bank',      label: 'Bank',       labelUr: 'بینک' },
  { id: 'card',      label: 'Card',       labelUr: 'کارڈ' },
  { id: 'other',     label: 'Other',      labelUr: 'دیگر' }
];

export const CHARGE_CATEGORIES = [
  { id: 'room',      label: 'Room charge', labelUr: 'کمرے کا کرایہ' },
  { id: 'food',      label: 'Food',        labelUr: 'کھانا' },
  { id: 'laundry',   label: 'Laundry',     labelUr: 'لانڈری' },
  { id: 'extrabed',  label: 'Extra bed',   labelUr: 'اضافی بستر' },
  { id: 'transport', label: 'Transport',   labelUr: 'ٹرانسپورٹ' },
  { id: 'service',   label: 'Other service', labelUr: 'دیگر سروس' },
  { id: 'custom',    label: 'Custom charge', labelUr: 'اضافی چارج' }
];

export const EXPENSE_CATEGORIES = [
  'Electricity', 'Gas', 'Water', 'Cleaning', 'Maintenance', 'Supplies',
  'Staff salary', 'Food & kitchen', 'Transport', 'Rent', 'Internet', 'Other'
];

export const GUEST_TYPES = [
  { id: 'individual', label: 'Individual', labelUr: 'انفرادی' },
  { id: 'family',     label: 'Family',     labelUr: 'خاندان' },
  { id: 'corporate',  label: 'Corporate',  labelUr: 'کارپوریٹ' },
  { id: 'group',      label: 'Tour group', labelUr: 'ٹور گروپ' },
  { id: 'vip',        label: 'VIP',        labelUr: 'وی آئی پی' },
  { id: 'blacklist',  label: 'Blacklisted', labelUr: 'بلیک لسٹ' }
];

/* ------------------------------------------------------------------ defaults */

export function defaultProperty() {
  return {
    id: 'property_main',
    name: 'Kalam Continental',
    nameUr: '',
    type: 'hotel',
    logo: '',
    phone: '',
    whatsapp: '',
    email: '',
    address: '',
    city: '',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    currency: 'Rs',
    taxEnabled: false,
    taxName: 'Tax',
    taxPercent: 5,
    taxInclusive: false,
    invoiceFooter: 'Thank you for staying with us.',
    receiptFooter: 'Thank you — please visit again.',
    createdAt: new Date().toISOString()
  };
}

export function defaultSettings() {
  return [
    {
      id: 'printer',
      // 80mm thermal defaults tuned for a standard 80mm/72mm-printable head.
      widthMm: 80,
      marginLeftMm: 3,
      marginRightMm: 3,
      marginTopMm: 3,
      marginBottomMm: 6,
      fontSizePt: 11,
      compactFontSizePt: 10,
      logoSizePx: 96,
      showLogo: true,
      mode: 'normal',          // 'normal' | 'compact'
      copies: 1,
      printerName: '',         // browsers cannot enumerate printers; this is a note for staff
      a4MarginMm: 12,
      openDialog: true
    },
    {
      id: 'booking',
      allowCheckoutWithBalance: true,
      warnOnBalance: true,
      defaultNights: 1,
      weekendDays: [0, 6],     // Sunday, Saturday
      requireCnic: true,
      autoDirtyOnCheckout: true,
      allowOverbook: false     // never enabled by the UI; present so the rule is explicit
    },
    {
      id: 'app',
      language: 'en',
      autoBackupEnabled: true,
      autoBackupEveryDays: 1,
      lastAutoBackupAt: '',
      demoDataLoaded: false
    }
  ];
}

export function defaultCounters() {
  return { id: 'counters', values: {}, updatedAt: new Date().toISOString() };
}

/* -------------------------------------------------------------- record shapes */

export function makeUnitType(patch) {
  return Object.assign({
    id: '', code: '', name: '', nameUr: '', description: '',
    capacityAdults: 2, capacityChildren: 1,
    defaultRate: 0, weekendRate: 0,
    extraPersonCharge: 0, extraBedCharge: 0,
    amenities: [], image: '', active: true,
    createdAt: new Date().toISOString(), archivedAt: null
  }, patch || {});
}

export function makeUnit(patch) {
  return Object.assign({
    id: '', code: '', unitTypeId: '', floor: '',
    capacityAdults: 2, capacityChildren: 1, bedConfig: '',
    baseRate: 0, weekendRate: 0, extraPersonCharge: 0, extraBedCharge: 0,
    amenities: [], description: '', notes: '',
    status: 'available', hkStatus: 'clean',
    active: true, createdAt: new Date().toISOString(), archivedAt: null
  }, patch || {});
}

export function makeGuest(patch) {
  return Object.assign({
    id: '', code: '', fullName: '', fullNameUr: '', fatherName: '',
    cnic: '', passport: '', phone: '', whatsapp: '',
    address: '', city: '', country: 'Pakistan', email: '',
    guestType: 'individual', notes: '',
    createdAt: new Date().toISOString(), updatedAt: '', archivedAt: null
  }, patch || {});
}

export function makeReservation(patch) {
  return Object.assign({
    id: '', code: '', registerNo: '', guestId: '', unitId: '', unitTypeId: '',
    checkIn: '', checkOut: '', nights: 0,
    adults: 1, children: 0,
    // Rate snapshot — frozen at creation so later price changes never rewrite
    // a historical booking (requirement 20/30).
    rate: 0, rateSnapshot: null,
    discount: 0, discountType: 'amount',   // 'amount' | 'percent'
    extraPersonCharge: 0, extraBedCharge: 0, extraBeds: 0,
    source: 'walkin', status: 'reserved',
    notes: '', companions: [],
    // Pakistan register fields, carried over from the prototype
    comingFrom: '', goingTo: '', vehicleNo: '', purpose: 'Tourism',
    invoiceNo: '',
    createdAt: new Date().toISOString(), createdBy: '',
    checkedInAt: null, checkedOutAt: null,
    cancelledAt: null, cancelReason: '',
    archivedAt: null
  }, patch || {});
}

export function makeFolioLine(patch) {
  return Object.assign({
    id: '', reservationId: '', date: '', category: 'custom',
    description: '', qty: 1, rate: 0, amount: 0,
    addedBy: '', createdAt: new Date().toISOString(),
    voided: false, voidReason: '', voidedAt: null, voidedBy: ''
  }, patch || {});
}

export function makePayment(patch) {
  return Object.assign({
    id: '', code: '', reservationId: '', guestId: '',
    amount: 0, method: 'cash', reference: '', notes: '',
    kind: 'payment',            // 'advance' | 'payment' | 'refund'
    at: new Date().toISOString(), userId: '',
    voided: false, voidReason: '', voidedAt: null, voidedBy: ''
  }, patch || {});
}

export function makeUser(patch) {
  return Object.assign({
    id: '', name: '', username: '', role: 'receptionist',
    pinHash: '', active: true, createdAt: new Date().toISOString(), archivedAt: null
  }, patch || {});
}

export function makeExpense(patch) {
  return Object.assign({
    id: '', code: '', date: '', category: 'Other', description: '',
    amount: 0, method: 'cash', paidTo: '', notes: '',
    userId: '', createdAt: new Date().toISOString(), voided: false
  }, patch || {});
}

export function makeMaintenance(patch) {
  return Object.assign({
    id: '', unitId: '', reason: '', startDate: '', expectedEnd: '',
    notes: '', status: 'open', createdAt: new Date().toISOString(),
    createdBy: '', completedAt: null, completedBy: ''
  }, patch || {});
}

/* ---------------------------------------------------------------- migrations */

/**
 * Migrations run in order on every boot. Each one must be safe to re-run:
 * it is given the whole dataset and returns nothing, mutating in place.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    up(data) {
      // Fill in fields added after a record was first written. Doing this here
      // rather than at read time keeps the rest of the code free of defaults.
      (data.units || []).forEach(u => {
        if (u.hkStatus === undefined) u.hkStatus = 'clean';
        if (u.active === undefined) u.active = true;
      });
      (data.reservations || []).forEach(r => {
        if (r.companions === undefined) r.companions = [];
        if (r.rateSnapshot === undefined) r.rateSnapshot = null;
      });
    }
  }
];

export function runMigrations(data, fromVersion) {
  let v = Number(fromVersion) || 0;
  for (const m of MIGRATIONS) {
    if (m.version > v) { m.up(data); v = m.version; }
  }
  return v;
}

export function propertyTypeOf(id) {
  return PROPERTY_TYPES.find(t => t.id === id) || PROPERTY_TYPES[0];
}
export function unitStatusOf(id) {
  return UNIT_STATUS.find(s => s.id === id) || UNIT_STATUS[0];
}
export function reservationStatusOf(id) {
  return RESERVATION_STATUS.find(s => s.id === id) || RESERVATION_STATUS[0];
}
export function hkStatusOf(id) {
  return HK_STATUS.find(s => s.id === id) || HK_STATUS[0];
}
export function methodLabel(id) {
  const m = PAYMENT_METHODS.find(x => x.id === id);
  return m ? m.label : (id || 'Other');
}
export function sourceLabel(id) {
  const s = BOOKING_SOURCES.find(x => x.id === id);
  return s ? s.label : (id || 'Other');
}
