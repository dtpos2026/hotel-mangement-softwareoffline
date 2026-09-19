/**
 * Input validation. Every rule returns null when the value is acceptable and a
 * human sentence when it is not — the UI shows that sentence verbatim.
 */

import { isValidDate, nightsBetween } from './dates.js';

export const CNIC_RE = /^\d{5}-\d{7}-\d$/;
export const PHONE_RE = /^(\+92|0)?3\d{2}[-\s]?\d{7}$/;

/** '1530212345671' -> '15302-1234567-1'. Typed digits become a CNIC as you go. */
export function formatCnic(value) {
  const d = String(value || '').replace(/\D/g, '').slice(0, 13);
  if (d.length <= 5) return d;
  if (d.length <= 12) return d.slice(0, 5) + '-' + d.slice(5);
  return d.slice(0, 5) + '-' + d.slice(5, 12) + '-' + d.slice(12);
}

export function formatPhone(value) {
  const d = String(value || '').replace(/[^\d+]/g, '').slice(0, 13);
  if (d.startsWith('+92')) return d;
  if (d.length <= 4) return d;
  return d.slice(0, 4) + '-' + d.slice(4, 11);
}

export function validCnic(value) {
  if (!value) return null;                      // optional unless the caller requires it
  return CNIC_RE.test(String(value).trim()) ? null : 'CNIC must look like 15302-1234567-1.';
}

export function validPhone(value) {
  if (!value) return null;
  const v = String(value).replace(/[-\s]/g, '');
  return PHONE_RE.test(v) ? null : 'Phone must look like 0300-1234567.';
}

export function validEmail(value) {
  if (!value) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value).trim()) ? null : 'Email address is not valid.';
}

export function required(value, label) {
  const v = typeof value === 'string' ? value.trim() : value;
  if (v === '' || v === null || v === undefined) return (label || 'This field') + ' is required.';
  return null;
}

export function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) return (label || 'Value') + ' must be a whole number of 0 or more.';
  return null;
}

export function validStayDates(checkIn, checkOut) {
  if (!checkIn) return 'Check-in date is required.';
  if (!checkOut) return 'Check-out date is required.';
  if (!isValidDate(checkIn)) return 'Check-in date is not a valid date.';
  if (!isValidDate(checkOut)) return 'Check-out date is not a valid date.';
  if (checkOut <= checkIn) return 'Check-out must be at least one night after check-in.';
  if (nightsBetween(checkIn, checkOut) > 365) return 'A single stay cannot be longer than 365 nights.';
  return null;
}

/** Runs a map of field -> rule results and returns only the failures. */
export function collect(checks) {
  const errors = {};
  for (const field of Object.keys(checks)) {
    const msg = checks[field];
    if (msg) errors[field] = msg;
  }
  return Object.keys(errors).length ? errors : null;
}

/** Guest privacy: '15302-1234567-1' -> '15302-•••••••-1' (requirement 36). */
export function maskCnic(value) {
  const v = String(value || '');
  if (!CNIC_RE.test(v)) return v;
  return v.slice(0, 6) + '•'.repeat(7) + v.slice(13);
}

export function maskPhone(value) {
  const v = String(value || '');
  if (v.length < 7) return v;
  return v.slice(0, v.length - 4).replace(/\d(?=\d{0,3}$)/g, '') + '••••';
}

/** Strips anything that could break a CSV cell or be read as a formula. */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
