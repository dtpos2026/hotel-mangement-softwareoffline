/**
 * Runs the domain layer under Node with no browser.
 *
 * db.js falls back to localStorage when IndexedDB is absent, so the only thing
 * that needs supplying is a localStorage — which also means these tests
 * exercise the fallback adapter, the one that runs on file:// in the field.
 */

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

export function installBrowserGlobals() {
  globalThis.localStorage = new MemoryStorage();
  if (typeof globalThis.indexedDB !== 'undefined') delete globalThis.indexedDB;
}

/* --------------------------------------------------------------- assertions */

let passed = 0, failed = 0, currentSuite = '';
const failures = [];

export function suite(name) { currentSuite = name; console.log('\n\x1b[1m' + name + '\x1b[0m'); }

export function ok(label, condition, detail) {
  if (condition) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else {
    failed++;
    failures.push(currentSuite + ' › ' + label + (detail ? '  (' + detail + ')' : ''));
    console.log('  \x1b[31m✗ ' + label + '\x1b[0m' + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : ''));
  }
}

export function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export async function throws(label, fn, codeOrMatch) {
  try {
    await fn();
    ok(label, false, 'expected it to be refused, but it succeeded');
  } catch (err) {
    if (!codeOrMatch) { ok(label, true); return err; }
    const matched = err.code === codeOrMatch || String(err.message).toLowerCase().indexOf(String(codeOrMatch).toLowerCase()) > -1;
    ok(label, matched, matched ? '' : `expected "${codeOrMatch}", got "${err.code || err.message}"`);
    return err;
  }
}

export function report() {
  console.log('\n' + '─'.repeat(60));
  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1mAll ${passed} checks passed.\x1b[0m`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failed} failed\x1b[0m, ${passed} passed.\n`);
    failures.forEach(f => console.log('  \x1b[31m•\x1b[0m ' + f));
  }
  console.log('─'.repeat(60));
  return failed;
}
