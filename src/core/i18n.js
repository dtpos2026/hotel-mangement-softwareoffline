/**
 * English / Urdu. The prototype's bilingual nav is kept and extended to the
 * whole product. Urdu is a full RTL mode, not a font swap.
 */

const EN = {
  // shell
  'app.offline': 'Offline mode — saved on this device',
  'app.search': 'Search guest, unit, CNIC, receipt…',
  'app.language': 'اردو',
  'app.save': 'Save', 'app.cancel': 'Cancel', 'app.delete': 'Delete', 'app.edit': 'Edit',
  'app.add': 'Add', 'app.close': 'Close', 'app.print': 'Print', 'app.preview': 'Preview',
  'app.export': 'Export CSV', 'app.confirm': 'Confirm', 'app.back': 'Back', 'app.archive': 'Archive',
  'app.restore': 'Restore', 'app.none': 'None', 'app.all': 'All', 'app.today': 'Today',
  'app.yes': 'Yes', 'app.no': 'No', 'app.required': 'Required', 'app.optional': 'Optional',
  'app.loading': 'Loading…', 'app.empty': 'Nothing here yet',

  // nav
  'nav.dashboard': 'Dashboard', 'nav.units': 'Units', 'nav.calendar': 'Calendar',
  'nav.reservations': 'Reservations', 'nav.checkin': 'Check In', 'nav.inhouse': 'In House',
  'nav.checkout': 'Check Out', 'nav.guests': 'Guests', 'nav.register': 'Register',
  'nav.payments': 'Payments', 'nav.housekeeping': 'Housekeeping', 'nav.expenses': 'Expenses',
  'nav.reports': 'Reports', 'nav.closing': 'Day Close', 'nav.settings': 'Settings',

  // statuses
  'status.available': 'Available', 'status.reserved': 'Reserved', 'status.occupied': 'Occupied',
  'status.cleaning': 'Cleaning', 'status.maintenance': 'Maintenance', 'status.blocked': 'Blocked',
  'status.dirty': 'Dirty', 'status.clean': 'Clean', 'status.inspected': 'Inspected',

  // messages
  'msg.saved': 'Saved successfully.',
  'msg.bookingSaved': 'Booking saved successfully.',
  'msg.paymentSaved': 'Payment recorded successfully.',
  'msg.unitUnavailable': 'Room/Unit is unavailable for the selected dates.',
  'msg.invalidCnic': 'CNIC must look like 15302-1234567-1.',
  'msg.invalidDates': 'Check-out must be at least one night after check-in.',
  'msg.balancePending': 'Checkout balance pending.',
  'msg.backupDone': 'Backup restored successfully.',
  'msg.restoreFailed': 'Restore failed — existing data was not changed.',
  'msg.checkedIn': 'Guest checked in.',
  'msg.checkedOut': 'Guest checked out.',
  'msg.deleteBlocked': 'This record has history and cannot be deleted. Archive it instead.',
  'msg.noPermission': 'Your role does not allow this action.'
};

const UR = {
  'app.offline': 'آف لائن موڈ — اسی کمپیوٹر پر محفوظ',
  'app.search': 'مہمان، کمرہ، شناختی کارڈ تلاش کریں…',
  'app.language': 'English',
  'app.save': 'محفوظ کریں', 'app.cancel': 'منسوخ', 'app.delete': 'حذف کریں', 'app.edit': 'ترمیم',
  'app.add': 'شامل کریں', 'app.close': 'بند کریں', 'app.print': 'پرنٹ', 'app.preview': 'جائزہ',
  'app.export': 'CSV برآمد', 'app.confirm': 'تصدیق', 'app.back': 'واپس', 'app.archive': 'محفوظ خانہ',
  'app.restore': 'بحال کریں', 'app.none': 'کوئی نہیں', 'app.all': 'سب', 'app.today': 'آج',
  'app.yes': 'ہاں', 'app.no': 'نہیں', 'app.required': 'لازمی', 'app.optional': 'اختیاری',
  'app.loading': 'لوڈ ہو رہا ہے…', 'app.empty': 'ابھی کچھ نہیں',

  'nav.dashboard': 'ڈیش بورڈ', 'nav.units': 'کمرے', 'nav.calendar': 'کیلنڈر',
  'nav.reservations': 'بکنگ', 'nav.checkin': 'آمد', 'nav.inhouse': 'موجود مہمان',
  'nav.checkout': 'روانگی', 'nav.guests': 'مہمان', 'nav.register': 'روزنامچہ',
  'nav.payments': 'وصولیاں', 'nav.housekeeping': 'صفائی', 'nav.expenses': 'اخراجات',
  'nav.reports': 'رپورٹس', 'nav.closing': 'یومیہ بندش', 'nav.settings': 'ترتیبات',

  'status.available': 'دستیاب', 'status.reserved': 'محفوظ', 'status.occupied': 'مصروف',
  'status.cleaning': 'صفائی', 'status.maintenance': 'مرمت', 'status.blocked': 'بند',
  'status.dirty': 'گندا', 'status.clean': 'صاف', 'status.inspected': 'معائنہ شدہ',

  'msg.saved': 'کامیابی سے محفوظ ہو گیا۔',
  'msg.bookingSaved': 'بکنگ کامیابی سے محفوظ ہو گئی۔',
  'msg.paymentSaved': 'ادائیگی درج ہو گئی۔',
  'msg.unitUnavailable': 'منتخب تاریخوں میں یہ کمرہ دستیاب نہیں ہے۔',
  'msg.invalidCnic': 'شناختی کارڈ نمبر 15302-1234567-1 کی طرح ہونا چاہیے۔',
  'msg.invalidDates': 'روانگی کی تاریخ آمد سے کم از کم ایک رات بعد ہونی چاہیے۔',
  'msg.balancePending': 'روانگی پر بقایا رقم باقی ہے۔',
  'msg.backupDone': 'بیک اپ کامیابی سے بحال ہو گیا۔',
  'msg.restoreFailed': 'بحالی ناکام — موجودہ ڈیٹا تبدیل نہیں ہوا۔',
  'msg.checkedIn': 'مہمان کی آمد درج ہو گئی۔',
  'msg.checkedOut': 'مہمان روانہ ہو گیا۔',
  'msg.deleteBlocked': 'اس ریکارڈ کی تاریخ موجود ہے، اسے حذف نہیں کیا جا سکتا۔ محفوظ خانے میں رکھیں۔',
  'msg.noPermission': 'آپ کے کردار کو اس کام کی اجازت نہیں ہے۔'
};

const DICTS = { en: EN, ur: UR };

let current = 'en';

export function setLanguage(lang) { current = DICTS[lang] ? lang : 'en'; }
export function getLanguage() { return current; }
export function isRtl() { return current === 'ur'; }
export function dir() { return current === 'ur' ? 'rtl' : 'ltr'; }

/** Translate. Falls back to English, then to the key itself. */
export function t(key, vars) {
  const dict = DICTS[current] || EN;
  let s = dict[key] !== undefined ? dict[key] : (EN[key] !== undefined ? EN[key] : key);
  if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}

/** Picks the Urdu label off a vocabulary entry when Urdu is active. */
export function pick(entry) {
  if (!entry) return '';
  return current === 'ur' && entry.labelUr ? entry.labelUr : (entry.label || '');
}

export { EN, UR };
