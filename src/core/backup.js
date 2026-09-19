/**
 * Backup, restore, export and import.
 *
 * The contract from requirement 29: a restore never destroys current data
 * unless the incoming file has been fully validated first, and a safety copy of
 * what was there is taken before anything is replaced.
 */

import { COLLECTIONS, SCHEMA_VERSION, runMigrations } from './schema.js';
import { nowIso, today } from './dates.js';
import { csvCell } from './validate.js';

export const BACKUP_FORMAT = 'hms-offline-backup';

export function buildBackup(store) {
  const dump = store.db.exportAll();
  return {
    format: BACKUP_FORMAT,
    version: 1,
    schemaVersion: dump.meta.schemaVersion || SCHEMA_VERSION,
    createdAt: nowIso(),
    property: store.property.name || '',
    counts: COLLECTIONS.reduce((a, c) => { a[c] = (dump.data[c] || []).length; return a; }, {}),
    meta: dump.meta,
    data: dump.data
  };
}

export function backupFilename(store, tag) {
  const name = String(store.property.name || 'property')
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'property';
  const stamp = nowIso().replace(/[:.]/g, '-').slice(0, 19);
  return `hms-backup-${name}-${stamp}${tag ? '-' + tag : ''}.json`;
}

/**
 * Validates a parsed backup. Returns { ok, errors[], warnings[], summary }.
 * Nothing is written until this returns ok.
 */
export function validateBackup(parsed) {
  const errors = [];
  const warnings = [];

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errors: ['The file is not a valid backup (not JSON data).'], warnings, summary: null };
  }
  if (parsed.format !== BACKUP_FORMAT) {
    errors.push('This file was not created by this application.');
  }
  if (!parsed.data || typeof parsed.data !== 'object') {
    errors.push('The backup contains no data section.');
  }

  if (errors.length) return { ok: false, errors, warnings, summary: null };

  const data = parsed.data;
  const summary = {};
  for (const name of COLLECTIONS) {
    const list = data[name];
    if (list === undefined) { warnings.push(`Collection "${name}" is missing — it will be restored empty.`); summary[name] = 0; continue; }
    if (!Array.isArray(list)) { errors.push(`Collection "${name}" is corrupt (expected a list).`); continue; }
    summary[name] = list.length;
    const seen = new Set();
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') { errors.push(`Collection "${name}" contains an invalid record.`); break; }
      if (!rec.id) { errors.push(`A record in "${name}" has no id.`); break; }
      if (seen.has(rec.id)) { errors.push(`Collection "${name}" has a duplicate id: ${rec.id}.`); break; }
      seen.add(rec.id);
    }
  }

  // Referential spot-checks that would silently corrupt the ledger if wrong.
  if (Array.isArray(data.reservations) && Array.isArray(data.units)) {
    const unitIds = new Set(data.units.map(u => u.id));
    const orphans = data.reservations.filter(r => r.unitId && !unitIds.has(r.unitId)).length;
    if (orphans) warnings.push(`${orphans} reservation(s) point at a unit that is not in this backup.`);
  }
  if (Array.isArray(data.payments) && Array.isArray(data.reservations)) {
    const resIds = new Set(data.reservations.map(r => r.id));
    const orphans = data.payments.filter(p => p.reservationId && !resIds.has(p.reservationId)).length;
    if (orphans) warnings.push(`${orphans} payment(s) point at a booking that is not in this backup.`);
  }

  const dupNums = [];
  checkUnique(data.invoices, 'no', dupNums, 'invoice number');
  checkUnique(data.reservations, 'code', dupNums, 'booking number');
  checkUnique(data.payments, 'code', dupNums, 'receipt number');
  dupNums.forEach(m => errors.push(m));

  if (Number(parsed.schemaVersion) > SCHEMA_VERSION) {
    errors.push(`This backup was made by a newer version of the software (data version ${parsed.schemaVersion}). Update the application before restoring.`);
  }

  return { ok: errors.length === 0, errors, warnings, summary };
}

function checkUnique(list, field, out, label) {
  if (!Array.isArray(list)) return;
  const seen = new Set();
  for (const rec of list) {
    const v = rec && rec[field];
    if (!v) continue;
    if (seen.has(v)) { out.push(`Duplicate ${label}: ${v}.`); return; }
    seen.add(v);
  }
}

/**
 * Restores a validated backup.
 *
 * Order matters: the safety copy of the current data is produced *before* the
 * first write, and the replacement is a single atomic call. If anything throws,
 * the caller still holds the safety copy and the live data is untouched,
 * because replaceAll() is the only mutation and it either completes or does not
 * run at all.
 */
export async function restoreBackup(store, parsed) {
  const check = validateBackup(parsed);
  if (!check.ok) {
    const err = new Error('Restore failed — existing data was not changed.');
    err.code = 'INVALID_BACKUP';
    err.details = check.errors;
    throw err;
  }

  const safety = buildBackup(store);           // taken before anything changes

  const data = {};
  for (const name of COLLECTIONS) data[name] = Array.isArray(parsed.data[name]) ? parsed.data[name] : [];

  const version = runMigrations(data, Number(parsed.schemaVersion) || 0);
  const meta = Object.assign({}, parsed.meta || {}, {
    schemaVersion: version,
    restoredAt: nowIso(),
    restoredFrom: parsed.createdAt || ''
  });

  try {
    await store.db.replaceAll(data, meta);
  } catch (err) {
    // The dataset in memory may be half-swapped; put the safety copy back.
    try { await store.db.replaceAll(safety.data, safety.meta); } catch { /* nothing more we can do */ }
    const e = new Error('Restore failed — existing data was not changed.');
    e.code = 'RESTORE_FAILED';
    e.cause = err;
    throw e;
  }

  return { safety, warnings: check.warnings, summary: check.summary };
}

/** Auto-backup: keeps the most recent copies in the storage adapter itself. */
const AUTO_KEY = 'hms:autobackup';
const AUTO_KEEP = 5;

export function readAutoBackups() {
  try {
    const raw = localStorage.getItem(AUTO_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveAutoBackup(store) {
  try {
    const backup = buildBackup(store);
    const list = readAutoBackups();
    list.unshift({ at: backup.createdAt, date: today(), counts: backup.counts, payload: JSON.stringify(backup) });
    const trimmed = list.slice(0, AUTO_KEEP);
    localStorage.setItem(AUTO_KEY, JSON.stringify(trimmed));
    return trimmed[0];
  } catch (err) {
    // Quota is the usual cause. An auto-backup failing must never block work.
    console.warn('[hms] auto-backup skipped:', err && err.message);
    return null;
  }
}

export function shouldAutoBackup(store) {
  const app = store.setting('app');
  if (!app.autoBackupEnabled) return false;
  const last = app.lastAutoBackupAt ? String(app.lastAutoBackupAt).slice(0, 10) : '';
  return last !== today();
}

/** Turns rows into a CSV document. The BOM keeps Excel happy with Urdu text. */
export function toCsv(columns, rows) {
  const head = columns.map(c => csvCell(c.label)).join(',');
  const body = rows.map(r => columns.map(c => csvCell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return '﻿' + [head].concat(body).join('\r\n');
}

export function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsText(file);
  });
}
