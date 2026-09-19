/**
 * Identifiers and document numbers.
 *
 * Record ids are opaque and collision-free. Document numbers (reservation,
 * invoice, receipt, register serial) are human-facing sequences and must never
 * repeat — requirement 30. Sequences are allocated inside the same transaction
 * that writes the record, and every allocation is re-checked against the live
 * collection before it is handed out.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomPart(len) {
  let out = '';
  const cryptoObj = typeof crypto !== 'undefined' ? crypto : null;
  if (cryptoObj && cryptoObj.getRandomValues) {
    const buf = new Uint8Array(len);
    cryptoObj.getRandomValues(buf);
    for (let i = 0; i < len; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  } else {
    for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** Time-ordered so that a natural sort is roughly a chronological sort. */
export function newId(prefix) {
  return (prefix ? prefix + '_' : '') + Date.now().toString(36) + randomPart(8);
}

export const SEQUENCES = {
  reservation: { prefix: 'RES', pad: 4, yearly: true },
  invoice:     { prefix: 'INV', pad: 4, yearly: true },
  receipt:     { prefix: 'RCP', pad: 4, yearly: true },
  register:    { prefix: '',    pad: 4, yearly: true },  // the روزنامچہ serial: 2026-0088
  guest:       { prefix: 'G',   pad: 5, yearly: false },
  expense:     { prefix: 'EXP', pad: 4, yearly: true },
  folio:       { prefix: 'F',   pad: 5, yearly: false }
};

function format(spec, year, n) {
  const num = String(n).padStart(spec.pad, '0');
  if (spec.yearly) return spec.prefix ? `${spec.prefix}-${year}-${num}` : `${year}-${num}`;
  return `${spec.prefix}${num}`;
}

/**
 * Allocates the next number for `kind`, writing the bumped counter through the
 * same transaction. `existing` is the live collection plus the field holding
 * the number, so a counter that has drifted (after a restore, say) can never
 * hand back a number that is already on a record.
 */
export function nextSequence(tx, counters, kind, opts) {
  const spec = SEQUENCES[kind];
  if (!spec) throw new Error('unknown sequence: ' + kind);
  const year = (opts && opts.year) || new Date().getFullYear();
  const key = spec.yearly ? `${kind}:${year}` : kind;

  let n = Number(counters.values[key] || 0);
  const taken = opts && opts.taken instanceof Set ? opts.taken : null;
  let candidate;
  do {
    n += 1;
    candidate = format(spec, year, n);
  } while (taken && taken.has(candidate));

  counters.values[key] = n;
  counters.updatedAt = new Date().toISOString();
  tx.put('counters', counters);
  return candidate;
}

/** Builds the `taken` set a caller passes to nextSequence. */
export function takenSet(records, field) {
  const s = new Set();
  for (const r of records) if (r && r[field]) s.add(r[field]);
  return s;
}
