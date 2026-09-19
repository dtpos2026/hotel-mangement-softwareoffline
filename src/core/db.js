/**
 * Offline storage engine.
 *
 * Design: the whole dataset is held in memory as plain objects and is queried
 * synchronously (hundreds of units / thousands of bookings fit comfortably, and
 * synchronous reads are what keep the UI instant — requirement 35). Durability
 * comes from an append-only journal plus periodic snapshots written through a
 * storage adapter.
 *
 * Two adapters exist behind one interface:
 *   IndexedDbAdapter   — preferred, used whenever IndexedDB is reachable.
 *   LocalStorageAdapter — automatic fallback. Chrome refuses IndexedDB on
 *                         file:// URLs, and this product is expected to be
 *                         opened straight off a USB stick or a desktop folder.
 *
 * Nothing here knows about hotels. Domain meaning lives in src/domain/.
 */

const DB_NAME = 'hms_offline';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const STORE_JOURNAL = 'journal';
const SNAPSHOT_KEY = 'snapshot';
const CHUNK_SIZE = 480 * 1024; // keeps each localStorage value well under quota
const JOURNAL_COMPACT_AT = 400; // entries before we fold the journal into a snapshot

/* ------------------------------------------------------------------ adapters */

class IndexedDbAdapter {
  constructor(db) { this.db = db; this.kind = 'indexeddb'; }

  static async open() {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
    const db = await new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE_KV)) d.createObjectStore(STORE_KV);
        if (!d.objectStoreNames.contains(STORE_JOURNAL)) {
          d.createObjectStore(STORE_JOURNAL, { keyPath: 'seq', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
    });
    return new IndexedDbAdapter(db);
  }

  _run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const os = tx.objectStore(store);
      let out;
      try { out = fn(os); } catch (err) { reject(err); return; }
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }

  async loadSnapshot() {
    const raw = await this._run(STORE_KV, 'readonly', os => os.get(SNAPSHOT_KEY));
    return raw ? JSON.parse(raw) : null;
  }

  async saveSnapshot(data) {
    const raw = JSON.stringify(data);
    await this._run(STORE_KV, 'readwrite', os => os.put(raw, SNAPSHOT_KEY));
  }

  async readJournal() {
    return await this._run(STORE_JOURNAL, 'readonly', os => os.getAll());
  }

  async appendJournal(entry) {
    await this._run(STORE_JOURNAL, 'readwrite', os => os.add(entry));
  }

  async clearJournal() {
    await this._run(STORE_JOURNAL, 'readwrite', os => os.clear());
  }

  async wipe() {
    await this._run(STORE_KV, 'readwrite', os => os.clear());
    await this.clearJournal();
  }
}

class LocalStorageAdapter {
  constructor() { this.kind = 'localstorage'; this.prefix = 'hms:'; }

  static async open() {
    if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
    const probe = '__hms_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return new LocalStorageAdapter();
  }

  async loadSnapshot() {
    const count = Number(localStorage.getItem(this.prefix + 'snapshot:chunks') || 0);
    if (!count) return null;
    let raw = '';
    for (let i = 0; i < count; i++) {
      const part = localStorage.getItem(this.prefix + 'snapshot:' + i);
      if (part == null) throw new Error('snapshot chunk ' + i + ' is missing');
      raw += part;
    }
    return JSON.parse(raw);
  }

  async saveSnapshot(data) {
    const raw = JSON.stringify(data);
    const chunks = Math.max(1, Math.ceil(raw.length / CHUNK_SIZE));
    // Write chunks first, flip the count last, so a half-written snapshot is
    // never advertised as complete.
    for (let i = 0; i < chunks; i++) {
      localStorage.setItem(this.prefix + 'snapshot:' + i, raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
    const old = Number(localStorage.getItem(this.prefix + 'snapshot:chunks') || 0);
    localStorage.setItem(this.prefix + 'snapshot:chunks', String(chunks));
    for (let i = chunks; i < old; i++) localStorage.removeItem(this.prefix + 'snapshot:' + i);
  }

  async readJournal() {
    const raw = localStorage.getItem(this.prefix + 'journal');
    return raw ? JSON.parse(raw) : [];
  }

  async appendJournal(entry) {
    const list = await this.readJournal();
    list.push(entry);
    localStorage.setItem(this.prefix + 'journal', JSON.stringify(list));
  }

  async clearJournal() {
    localStorage.removeItem(this.prefix + 'journal');
  }

  async wipe() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.prefix)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  }
}

/* ------------------------------------------------------------------ database */

export class Database {
  constructor(adapter, collections) {
    this.adapter = adapter;
    this.collections = collections;   // name -> array of records
    this._indexes = new Map();        // "collection.field" -> Map(value -> record[])
    this._meta = { schemaVersion: 0, createdAt: null, updatedAt: null };
    this._journalCount = 0;
    this._queue = Promise.resolve();  // serialises every write
    this._listeners = new Set();
    this.degraded = false;            // true when running on the fallback adapter
    this.lastError = null;
  }

  static async open(collectionNames) {
    let adapter, degraded = false;
    try {
      adapter = await IndexedDbAdapter.open();
    } catch (err) {
      console.warn('[hms] IndexedDB unavailable, falling back to localStorage:', err && err.message);
      adapter = await LocalStorageAdapter.open();
      degraded = true;
    }

    const collections = {};
    collectionNames.forEach(n => { collections[n] = []; });
    const db = new Database(adapter, collections);
    db.degraded = degraded;

    const snap = await adapter.loadSnapshot();
    if (snap) {
      db._meta = snap.meta || db._meta;
      for (const name of collectionNames) {
        db.collections[name] = Array.isArray(snap.data && snap.data[name]) ? snap.data[name] : [];
      }
    }

    // Replay anything journalled after the last snapshot.
    const journal = await adapter.readJournal();
    for (const entry of journal) db._applyOps(entry.ops || []);
    db._journalCount = journal.length;
    if (journal.length > 0) await db._snapshot();

    db._rebuildIndexes();
    return db;
  }

  /* --- change notification ------------------------------------------------ */

  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _emit(collectionsTouched) {
    for (const fn of this._listeners) {
      try { fn(collectionsTouched); } catch (err) { console.error('[hms] listener failed:', err); }
    }
  }

  /* --- synchronous reads --------------------------------------------------- */

  all(collection) { return this.collections[collection] || []; }

  /** Live (non-archived) records only. */
  live(collection) {
    return this.all(collection).filter(r => !r._deleted && !r.archivedAt);
  }

  get(collection, id) {
    const idx = this._index(collection, 'id');
    const hit = idx.get(id);
    return hit && hit.length ? hit[0] : null;
  }

  /** Indexed equality lookup. Falls back to a scan for unindexed fields. */
  where(collection, field, value) {
    const idx = this._index(collection, field);
    return (idx.get(value) || []).slice();
  }

  find(collection, predicate) { return this.all(collection).filter(predicate); }

  first(collection, predicate) { return this.all(collection).find(predicate) || null; }

  count(collection, predicate) {
    return predicate ? this.all(collection).filter(predicate).length : this.all(collection).length;
  }

  /* --- indexes ------------------------------------------------------------- */

  _index(collection, field) {
    const key = collection + '.' + field;
    let idx = this._indexes.get(key);
    if (!idx) {
      idx = new Map();
      for (const rec of this.all(collection)) {
        const v = rec[field];
        if (v === undefined || v === null) continue;
        const bucket = idx.get(v);
        if (bucket) bucket.push(rec); else idx.set(v, [rec]);
      }
      this._indexes.set(key, idx);
    }
    return idx;
  }

  _rebuildIndexes(collection) {
    if (!collection) { this._indexes.clear(); return; }
    for (const key of Array.from(this._indexes.keys())) {
      if (key.startsWith(collection + '.')) this._indexes.delete(key);
    }
  }

  /* --- writes -------------------------------------------------------------- */

  /**
   * Runs `fn` against a transaction object, then commits every operation it
   * recorded as a single durable unit. If `fn` throws, nothing is written.
   * Writes are serialised, so two concurrent callers can never interleave.
   */
  transaction(fn) {
    const run = async () => {
      const tx = new Transaction(this);
      const result = fn(tx);           // may throw — nothing applied yet
      if (result && typeof result.then === 'function') {
        throw new Error('transaction callbacks must be synchronous');
      }
      if (tx.ops.length === 0) return result;

      const entry = { ts: Date.now(), ops: tx.ops };
      this._applyOps(tx.ops);          // memory first, so reads are instant
      const touched = new Set(tx.ops.map(o => o.c));
      this._meta.updatedAt = new Date().toISOString();

      try {
        await this.adapter.appendJournal(entry);
        this._journalCount++;
        if (this._journalCount >= JOURNAL_COMPACT_AT) await this._snapshot();
      } catch (err) {
        this.lastError = err;
        throw new Error('Could not save to disk: ' + (err && err.message ? err.message : err));
      }

      this._emit(touched);
      return result;
    };

    // Chain onto the queue but keep the caller's own error/result.
    const chained = this._queue.then(run, run);
    this._queue = chained.catch(() => {});
    return chained;
  }

  _applyOps(ops) {
    for (const op of ops) {
      const list = this.collections[op.c];
      if (!list) continue;
      if (op.t === 'put') {
        const i = list.findIndex(r => r.id === op.v.id);
        if (i >= 0) list[i] = op.v; else list.push(op.v);
      } else if (op.t === 'del') {
        const i = list.findIndex(r => r.id === op.id);
        if (i >= 0) list.splice(i, 1);
      }
      this._rebuildIndexes(op.c);
    }
  }

  async _snapshot() {
    await this.adapter.saveSnapshot({ meta: this._meta, data: this.collections });
    await this.adapter.clearJournal();
    this._journalCount = 0;
  }

  /** Forces a snapshot — called before backups and on page unload. */
  async flush() {
    await this._queue;
    if (this._journalCount > 0) await this._snapshot();
  }

  get meta() { return this._meta; }
  setMeta(patch) { Object.assign(this._meta, patch); }

  /** Replaces the entire dataset. Used only by restore, which validates first. */
  async replaceAll(data, meta) {
    await this._queue;
    for (const name of Object.keys(this.collections)) {
      this.collections[name] = Array.isArray(data[name]) ? data[name] : [];
    }
    if (meta) this._meta = Object.assign({}, this._meta, meta);
    this._meta.updatedAt = new Date().toISOString();
    this._indexes.clear();
    await this.adapter.clearJournal();
    this._journalCount = 0;
    await this.adapter.saveSnapshot({ meta: this._meta, data: this.collections });
    this._emit(new Set(Object.keys(this.collections)));
  }

  /** Serialisable copy of everything — the basis of every backup. */
  exportAll() {
    return JSON.parse(JSON.stringify({ meta: this._meta, data: this.collections }));
  }

  storageKind() { return this.adapter.kind; }

  async estimateSize() {
    try { return JSON.stringify(this.collections).length; } catch { return 0; }
  }
}

/** Collects operations; nothing is applied until the transaction commits. */
class Transaction {
  constructor(db) { this.db = db; this.ops = []; }

  put(collection, record) {
    if (!record || !record.id) throw new Error('put() needs a record with an id');
    this.ops.push({ t: 'put', c: collection, v: JSON.parse(JSON.stringify(record)) });
    return record;
  }

  remove(collection, id) {
    this.ops.push({ t: 'del', c: collection, id });
  }

  /** Reads see committed state; a transaction never reads its own pending ops. */
  get(collection, id) { return this.db.get(collection, id); }
  all(collection) { return this.db.all(collection); }
  find(collection, p) { return this.db.find(collection, p); }
}

export { IndexedDbAdapter, LocalStorageAdapter };
