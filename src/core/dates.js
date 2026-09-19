/**
 * Dates are stored as 'YYYY-MM-DD' strings and timestamps as ISO strings.
 *
 * Plain date strings sidestep every timezone trap: a stay from the 3rd to the
 * 5th is the 3rd to the 5th regardless of where the machine thinks it is, and
 * string comparison is chronological comparison.
 */

const MS_DAY = 86400000;

export function today() { return toDateStr(new Date()); }

export function nowIso() { return new Date().toISOString(); }

export function toDateStr(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parses 'YYYY-MM-DD' at local noon — immune to DST shifting the day. */
export function parseDate(str) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str));
  if (!m) { const d = new Date(str); return isNaN(d.getTime()) ? null : d; }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

export function isValidDate(str) { return parseDate(str) !== null; }

export function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  if (!d) return '';
  d.setDate(d.getDate() + Number(days || 0));
  return toDateStr(d);
}

/** Nights between two dates. Check-in 03, check-out 05 = 2 nights. */
export function nightsBetween(checkIn, checkOut) {
  const a = parseDate(checkIn), b = parseDate(checkOut);
  if (!a || !b) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / MS_DAY));
}

/** Every date a stay physically occupies — the checkout date is not one of them. */
export function nightsList(checkIn, checkOut) {
  const out = [];
  const n = nightsBetween(checkIn, checkOut);
  for (let i = 0; i < n; i++) out.push(addDays(checkIn, i));
  return out;
}

/**
 * Half-open overlap: [aIn, aOut) vs [bIn, bOut).
 * One guest checking out on the 5th and another checking in on the 5th do not
 * overlap. This single rule is what the double-booking guard rests on.
 */
export function rangesOverlap(aIn, aOut, bIn, bOut) {
  if (!aIn || !aOut || !bIn || !bOut) return false;
  return aIn < bOut && bIn < aOut;
}

export function isWeekend(dateStr, weekendDays) {
  const d = parseDate(dateStr);
  if (!d) return false;
  const days = Array.isArray(weekendDays) && weekendDays.length ? weekendDays : [0, 6]; // Sun, Sat
  return days.indexOf(d.getDay()) > -1;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** '05 Aug 2026' */
export function formatDate(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return '—';
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** '05 Aug' */
export function formatDateShort(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return '—';
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`;
}

/** '05 Aug 2026 · Tue' */
export function formatDateLong(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return '—';
  return `${formatDate(dateStr)} · ${DAYS[d.getDay()]}`;
}

export function dayName(dateStr) {
  const d = parseDate(dateStr);
  return d ? DAYS[d.getDay()] : '';
}

/** '02:10 PM' from an ISO timestamp. */
export function formatTime(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return '—';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${m} ${ap}`;
}

/** '05 Aug 2026 · 02:10 PM' */
export function formatDateTime(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${formatDate(toDateStr(d))} · ${formatTime(d)}`;
}

export function dateOfIso(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d.getTime()) ? '' : toDateStr(d);
}

export function startOfWeek(dateStr) {
  const d = parseDate(dateStr) || new Date();
  d.setDate(d.getDate() - d.getDay());
  return toDateStr(d);
}

export function startOfMonth(dateStr) {
  const d = parseDate(dateStr) || new Date();
  return toDateStr(new Date(d.getFullYear(), d.getMonth(), 1, 12));
}

export function endOfMonth(dateStr) {
  const d = parseDate(dateStr) || new Date();
  return toDateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12));
}

export function monthLabel(dateStr) {
  const d = parseDate(dateStr) || new Date();
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Named report ranges — the filter set required by requirement 26. */
export function presetRange(preset, ref) {
  const base = ref || today();
  switch (preset) {
    case 'today':      return { from: base, to: base, label: 'Today' };
    case 'yesterday': { const y = addDays(base, -1); return { from: y, to: y, label: 'Yesterday' }; }
    case 'week':       return { from: startOfWeek(base), to: addDays(startOfWeek(base), 6), label: 'This week' };
    case 'month':      return { from: startOfMonth(base), to: endOfMonth(base), label: 'This month' };
    case 'last30':     return { from: addDays(base, -29), to: base, label: 'Last 30 days' };
    case 'year':       return { from: base.slice(0, 4) + '-01-01', to: base.slice(0, 4) + '-12-31', label: 'This year' };
    default:           return { from: base, to: base, label: 'Today' };
  }
}

export function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/** Inclusive list of dates, used by the availability calendar. */
export function eachDay(from, to, limit) {
  const out = [];
  const max = limit || 400;
  let cur = from;
  while (cur && cur <= to && out.length < max) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

export { MONTHS, DAYS };
