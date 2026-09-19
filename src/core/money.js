/**
 * Money is integer rupees. Never a float, anywhere in the financial path.
 *
 * PKR is not used in sub-rupee amounts in hospitality, and floats would make
 * invoice totals drift — requirement 30 says historical financial records must
 * stay exactly what they were.
 */

/** Parses anything a user or an old record can hold into integer rupees. */
export function toMoney(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : 0;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function add(...values) { return values.reduce((sum, v) => sum + toMoney(v), 0); }
export function sub(a, b) { return toMoney(a) - toMoney(b); }
export function mul(amount, qty) { return Math.round(toMoney(amount) * (Number(qty) || 0)); }

/** Percentage of an amount, rounded to the rupee. */
export function percent(amount, pct) {
  const p = Number(pct);
  if (!Number.isFinite(p) || p === 0) return 0;
  return Math.round(toMoney(amount) * p / 100);
}

export function clampPositive(amount) { return Math.max(0, toMoney(amount)); }

/** "12,050" — grouping only, no symbol. Used inside tables. */
export function formatNumber(amount) {
  const n = toMoney(amount);
  const neg = n < 0;
  const s = Math.abs(n).toLocaleString('en-US');
  return neg ? '−' + s : s;
}

/** "Rs 12,050" — the display form used across the UI and on print. */
export function formatMoney(amount, currency) {
  const symbol = currency || 'Rs';
  return symbol + ' ' + formatNumber(amount);
}

/** Plain digits for CSV and print columns that already carry a currency header. */
export function formatPlain(amount) { return String(toMoney(amount)); }

/** Urdu-facing amount in words, used on invoices. Handles the lakh/crore system. */
export function amountInWords(amount) {
  const n = Math.abs(toMoney(amount));
  if (n === 0) return 'Zero Rupees Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const under1000 = v => {
    if (v === 0) return '';
    if (v < 20) return ones[v];
    if (v < 100) return tens[Math.floor(v / 10)] + (v % 10 ? ' ' + ones[v % 10] : '');
    return ones[Math.floor(v / 100)] + ' Hundred' + (v % 100 ? ' ' + under1000(v % 100) : '');
  };
  const parts = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(under1000(crore) + ' Crore');
  if (lakh) parts.push(under1000(lakh) + ' Lakh');
  if (thousand) parts.push(under1000(thousand) + ' Thousand');
  if (rest) parts.push(under1000(rest));
  return (toMoney(amount) < 0 ? 'Minus ' : '') + parts.join(' ') + ' Rupees Only';
}
