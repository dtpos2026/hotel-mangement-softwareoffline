/**
 * Licence storage and verification in the main process.
 *
 * Verification happens here rather than in the renderer so the check is not
 * sitting in page JavaScript where it could be stepped over with devtools. The
 * licence itself is kept in userData, separate from the application database,
 * so clearing or restoring data never deactivates the software.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createPublicKey, verify, createHash } = require('node:crypto');

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TRIAL_DAYS = 14;

class LicenceStore {
  constructor(userDataPath, publicKeyB64) {
    this.file = path.join(userDataPath, 'licence.json');
    this.publicKeyB64 = publicKeyB64;
    this.state = this._read();
  }

  _read() {
    try {
      if (fs.existsSync(this.file)) return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      console.error('[licence] could not read the licence file:', err.message);
    }
    return { key: '', activatedAt: '', firstRunAt: '' };
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[licence] could not save the licence file:', err.message);
      return false;
    }
  }

  /** Stamped once, on the very first launch, to anchor the trial period. */
  ensureFirstRun() {
    if (!this.state.firstRunAt) {
      this.state.firstRunAt = new Date().toISOString();
      this._write();
    }
    return this.state.firstRunAt;
  }

  verifySignature(payload, signature) {
    try {
      const raw = Buffer.from(this.publicKeyB64, 'base64');
      if (raw.length !== 32) return false;
      const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
      return verify(null, Buffer.from(payload), key, Buffer.from(signature));
    } catch (err) {
      console.error('[licence] signature check failed:', err.message);
      return false;
    }
  }

  save(key) {
    this.state.key = String(key || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    this.state.activatedAt = new Date().toISOString();
    return this._write();
  }

  clear() {
    this.state.key = '';
    this.state.activatedAt = '';
    return this._write();
  }

  get key() { return this.state.key; }
  get activatedAt() { return this.state.activatedAt; }

  /**
   * Days left in the free trial. The trial is anchored to the first launch and
   * is deliberately generous rather than clever — a determined user can reset
   * it by clearing userData, and chasing that is not worth the support calls
   * an over-tight check would cause.
   */
  trialDaysLeft() {
    const start = this.ensureFirstRun();
    const elapsed = Math.floor((Date.now() - new Date(start).getTime()) / 86400000);
    return Math.max(0, TRIAL_DAYS - elapsed);
  }
}

module.exports = { LicenceStore, TRIAL_DAYS };
