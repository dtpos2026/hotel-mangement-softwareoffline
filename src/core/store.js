/**
 * Application context: one object that owns the database, the session, the
 * settings and the change-notification bus. Domain services and the UI both
 * receive it; neither constructs it.
 */

import { Database } from './db.js';
import { COLLECTIONS, SCHEMA_VERSION, runMigrations, defaultProperty, defaultSettings, defaultCounters } from './schema.js';
import { Session, hashPassword, verifyPassword, newSalt, DEFAULT_USERNAME, DEFAULT_PASSWORD } from './auth.js';
import { newId } from './ids.js';
import { setLanguage } from './i18n.js';
import { nowIso, today } from './dates.js';

export class AppStore {
  constructor(db) {
    this.db = db;
    this.session = new Session(null);
    this._listeners = new Set();
    this._auditQueued = [];
    db.subscribe(touched => this._emit(touched));
  }

  static async boot() {
    const db = await Database.open(COLLECTIONS);

    // Migrate before anything reads a record.
    const from = db.meta.schemaVersion || 0;
    const to = runMigrations(db.collections, from);
    if (to !== from) {
      db.setMeta({ schemaVersion: to });
      await db.flush();
    }
    if (!db.meta.createdAt) db.setMeta({ createdAt: nowIso(), schemaVersion: SCHEMA_VERSION });

    const store = new AppStore(db);
    await store._ensureDefaults();
    setLanguage(store.setting('app').language || 'en');
    return store;
  }

  /** First run: property profile, settings rows, counters and an admin user. */
  async _ensureDefaults() {
    const needProperty = this.db.all('property').length === 0;
    const needCounters = this.db.all('counters').length === 0;
    const existingSettings = new Set(this.db.all('settings').map(s => s.id));
    const missingSettings = defaultSettings().filter(s => !existingSettings.has(s.id));
    const needUser = this.db.all('users').length === 0;

    if (!needProperty && !needCounters && !missingSettings.length && !needUser) return;

    let adminRecord = null;
    if (needUser) {
      // The documented starting account. mustChangePassword makes the software
      // insist on a new one at first sign-in, so no property is left running
      // on a password that is printed in the manual.
      const salt = newSalt();
      adminRecord = {
        id: newId('u'), name: 'Administrator', username: DEFAULT_USERNAME, role: 'admin',
        salt, passwordHash: await hashPassword(DEFAULT_PASSWORD, salt), active: true,
        mustChangePassword: true, createdAt: nowIso(), archivedAt: null
      };
    }

    await this.db.transaction(tx => {
      if (needProperty) tx.put('property', defaultProperty());
      if (needCounters) tx.put('counters', defaultCounters());
      missingSettings.forEach(s => tx.put('settings', s));
      if (adminRecord) tx.put('users', adminRecord);
    });
  }

  /* --- change bus ---------------------------------------------------------- */

  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _emit(touched) {
    for (const fn of this._listeners) {
      try { fn(touched); } catch (err) { console.error('[hms] store listener failed:', err); }
    }
  }

  /* --- convenience reads --------------------------------------------------- */

  get property() { return this.db.all('property')[0] || defaultProperty(); }

  setting(id) {
    const row = this.db.get('settings', id);
    if (row) return row;
    return defaultSettings().find(s => s.id === id) || { id };
  }

  counters() { return this.db.get('counters', 'counters') || defaultCounters(); }

  users() { return this.db.live('users'); }

  currency() { return this.property.currency || 'Rs'; }

  /** The word this property calls a unit: Room, Cottage, Apartment, Bed… */
  unitWord() {
    const type = this.property.type;
    const map = { hotel: 'Room', guesthouse: 'Room', resort: 'Unit', apartment: 'Apartment',
                  villa: 'Villa', cottage: 'Cottage', hostel: 'Bed', other: 'Unit' };
    return map[type] || 'Unit';
  }

  /* --- writes -------------------------------------------------------------- */

  /**
   * Every domain write goes through here so that the audit trail is written in
   * the same transaction as the change it describes — they cannot drift apart.
   */
  async write(action, fn) {
    const session = this.session;
    return this.db.transaction(tx => {
      const audit = [];
      const record = (entity, entityId, details) => {
        audit.push({
          id: newId('a'), at: nowIso(), userId: session.id, userName: session.name,
          action, entity, entityId: entityId || '', details: details || null, date: today()
        });
      };
      const result = fn(tx, record);
      audit.forEach(a => tx.put('auditLog', a));
      return result;
    });
  }

  /**
   * Language and other per-device preferences are open to anyone signed in;
   * everything else in settings is guarded. Without this split a receptionist
   * could rewrite the tax rate or the printer profile.
   */
  async updateSetting(id, patch) {
    // lastAutoBackupAt is system bookkeeping, not a user setting, so the
    // automatic daily backup still records itself under any role.
    const OPEN_KEYS = ['language', 'lastAutoBackupAt'];
    const guarded = id !== 'app' || Object.keys(patch).some(k => OPEN_KEYS.indexOf(k) === -1);
    if (guarded) this.session.require('settings.manage');

    const current = this.setting(id);
    const next = Object.assign({}, current, patch, { id });
    await this.write('settings.update', (tx, log) => {
      tx.put('settings', next);
      log('settings', id, { keys: Object.keys(patch) });
    });
    if (id === 'app' && patch.language) setLanguage(patch.language);
    return next;
  }

  async updateProperty(patch) {
    this.session.require('settings.manage');
    const next = Object.assign({}, this.property, patch, { updatedAt: nowIso() });
    await this.write('property.update', (tx, log) => {
      tx.put('property', next);
      log('property', next.id, { keys: Object.keys(patch) });
    });
    return next;
  }

  /* --- session ------------------------------------------------------------- */

  signIn(user) {
    this.session = new Session(user);
    this._emit(new Set(['session']));
    return this.session;
  }

  signOut() {
    this.session = new Session(null);
    this._emit(new Set(['session']));
  }

  /** Sign-in check. Accepts a record written under the older PIN field too. */
  async verifyPassword(user, password) {
    if (!user || !user.active) return false;
    const stored = user.passwordHash || user.pinHash || '';
    if (!stored) return false;
    return verifyPassword(password, user.salt || '', stored);
  }

  /** Kept for older call sites. */
  async verifyPin(user, pin) { return this.verifyPassword(user, pin); }

  /** Finds a user by username, case-insensitively. */
  findUser(username) {
    const u = String(username || '').trim().toLowerCase();
    if (!u) return null;
    return this.db.live('users').find(x =>
      String(x.username || '').toLowerCase() === u && x.active) || null;
  }

  /** Changes a password and clears the must-change flag. */
  async setPassword(userId, password) {
    const user = this.db.get('users', userId);
    if (!user) throw new Error('User not found.');
    const salt = newSalt();
    const next = Object.assign({}, user, {
      salt,
      passwordHash: await hashPassword(password, salt),
      pinHash: '',
      mustChangePassword: false,
      passwordChangedAt: nowIso()
    });
    await this.write('user.password', (tx, log) => {
      tx.put('users', next);
      log('users', userId, { name: user.name });
    });
    if (this.session.id === userId) this.session = new Session(next);
    return next;
  }

  /* --- diagnostics --------------------------------------------------------- */

  health() {
    return {
      storage: this.db.storageKind(),
      degraded: this.db.degraded,
      schemaVersion: this.db.meta.schemaVersion,
      createdAt: this.db.meta.createdAt,
      updatedAt: this.db.meta.updatedAt,
      counts: COLLECTIONS.reduce((acc, c) => { acc[c] = this.db.all(c).length; return acc; }, {})
    };
  }
}
