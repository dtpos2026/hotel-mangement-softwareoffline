/**
 * Licence state on this computer.
 *
 * Activation happens once, online, against Firestore. Everything after that is
 * read from a local cache so the software runs with no internet, which is the
 * whole point of the product.
 *
 * The cache carries an HMAC derived from this machine's fingerprint. That
 * stops the file being edited by hand or copied to another computer. It is not
 * unbreakable — the derivation lives in an app anyone can unpack — but it is
 * proportionate: the real control is that a licence binds to one machine in
 * Firestore, so a copied cache shows up as a second computer using one key.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createHmac, createHash } = require('node:crypto');

/** Re-check with Firestore this often, when the internet happens to be there. */
const RECHECK_DAYS = 1;
/** How long a licence may go unverified before the app insists on a re-check. */
const GRACE_DAYS = 45;

class LicenceStore {
  constructor(userDataPath, machineId) {
    this.file = path.join(userDataPath, 'licence.json');
    this.machineId = machineId;
    this.state = this._read();
  }

  _secret() {
    // Bound to the machine, so a cache lifted to another PC fails its HMAC.
    return createHash('sha256').update('hotel-register:licence:v1:' + this.machineId).digest();
  }

  _sign(payload) {
    return createHmac('sha256', this._secret()).update(JSON.stringify(payload)).digest('hex');
  }

  _read() {
    try {
      if (!fs.existsSync(this.file)) return this._blank();
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));

      // A cache that fails its signature is discarded, but the first-run date
      // is carried over: it anchors nothing security-relevant, and resetting
      // it on every corrupt read would hand a fresh grace period to anyone who
      // simply deleted the signature.
      const keepFirstRun = (raw && raw.payload && raw.payload.firstRunAt) || '';

      if (!raw || !raw.payload || !raw.mac) {
        return Object.assign(this._blank(), { firstRunAt: keepFirstRun });
      }
      if (this._sign(raw.payload) !== raw.mac) {
        console.warn('[licence] the cached licence does not match this computer; activation is required again.');
        return Object.assign(this._blank(), { tampered: true, firstRunAt: keepFirstRun });
      }
      return raw.payload;
    } catch (err) {
      console.error('[licence] could not read the licence cache:', err.message);
      return this._blank();
    }
  }

  _blank() {
    return { key: '', record: null, activatedAt: '', lastVerifiedAt: '', firstRunAt: '' };
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        payload: this.state,
        mac: this._sign(this.state)
      }, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[licence] could not save the licence cache:', err.message);
      return false;
    }
  }

  ensureFirstRun() {
    if (!this.state.firstRunAt) {
      this.state.firstRunAt = new Date().toISOString();
      this._write();
    }
    return this.state.firstRunAt;
  }

  /** Stores a verified licence record. */
  save(key, record) {
    this.ensureFirstRun();
    this.state.key = key;
    this.state.record = record;
    this.state.activatedAt = this.state.activatedAt || new Date().toISOString();
    this.state.lastVerifiedAt = new Date().toISOString();
    this.state.tampered = false;
    return this._write();
  }

  /** Refreshes the cached copy after a successful re-check. */
  refresh(record) {
    this.state.record = record;
    this.state.lastVerifiedAt = new Date().toISOString();
    return this._write();
  }

  clear() {
    const firstRun = this.state.firstRunAt;
    this.state = Object.assign(this._blank(), { firstRunAt: firstRun });
    return this._write();
  }

  get key() { return this.state.key; }
  get record() { return this.state.record; }
  get activatedAt() { return this.state.activatedAt; }
  get lastVerifiedAt() { return this.state.lastVerifiedAt; }
  get tampered() { return !!this.state.tampered; }
  get activated() { return !!(this.state.key && this.state.record); }

  daysSinceVerified() {
    if (!this.state.lastVerifiedAt) return Infinity;
    return Math.floor((Date.now() - new Date(this.state.lastVerifiedAt).getTime()) / 86400000);
  }

  /** True when a background re-check would be worthwhile. */
  shouldRecheck() {
    return this.activated && this.daysSinceVerified() >= RECHECK_DAYS;
  }

  /** True when too long has passed offline and a re-check is now required. */
  pastGrace() {
    return this.activated && this.daysSinceVerified() > GRACE_DAYS;
  }
}

module.exports = { LicenceStore, RECHECK_DAYS, GRACE_DAYS };
