/**
 * Activation and licence checking.
 *
 * Activation needs the internet once. Everything afterwards reads the local
 * cache, so the software works in a valley with no signal — which is where a
 * good share of these properties actually are.
 */

const { FirebaseRest } = require('./firebase-rest.cjs');
const { LicenceStore, RECHECK_DAYS, GRACE_DAYS } = require('./licence-store.cjs');
const firebaseConfig = require('./firebase-config.cjs');

class LicenceService {
  constructor(userDataPath, machineId, machineCode, licenceModel) {
    this.store = new LicenceStore(userDataPath, machineId);
    this.machineId = machineId;
    this.machineCode = machineCode;
    this.model = licenceModel;                 // the shared ESM licence-model
    this.firebase = new FirebaseRest(firebaseConfig);
    this.store.ensureFirstRun();
  }

  /**
   * Verifies a key against Firestore and, on success, binds it to this
   * computer and caches it.
   */
  async activate(rawKey) {
    const model = this.model;

    if (!model.isWellFormed(rawKey)) {
      return { ok: false, status: model.STATUS.MALFORMED,
        message: 'That does not look like a licence key. It should read like HR-4F2K-9XQP-7M3A.' };
    }
    if (!this.firebase.configured) {
      return { ok: false, status: 'unconfigured',
        message: 'This copy was built without licence server details. Contact your supplier.' };
    }

    const docId = model.keyToDocId(rawKey);
    let record;
    try {
      record = await this.firebase.getDoc(firebaseConfig.licencesCollection, docId);
    } catch (err) {
      if (err.offline) {
        return { ok: false, status: model.STATUS.OFFLINE, offline: true,
          message: 'Activation needs an internet connection this one time. Connect to the internet, or use a phone hotspot, and try again. After activation the software works offline.' };
      }
      return { ok: false, status: 'error', message: err.message };
    }

    const verdict = model.evaluateRecord(record, this.machineId);
    if (!verdict.ok) return Object.assign({ ok: false }, verdict);

    // First activation claims the licence for this computer.
    if (verdict.firstActivation) {
      try {
        await this.firebase.patchDoc(firebaseConfig.licencesCollection, docId, {
          machineId: this.machineId,
          machineCode: this.machineCode,
          activatedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString()
        });
        record.machineId = this.machineId;
        record.machineCode = this.machineCode;
        record.activatedAt = new Date().toISOString();
      } catch (err) {
        // Binding is a convenience for the vendor, not a gate. If the write is
        // refused, the customer still gets the software they paid for.
        console.warn('[licence] could not record the activation:', err.message);
      }
    } else {
      this._touch(docId);
    }

    record.key = model.formatKey(rawKey);
    this.store.save(model.formatKey(rawKey), record);
    return { ok: true, status: verdict.status, message: verdict.message, record };
  }

  /** Best-effort "this copy is alive" ping. Never blocks anything. */
  _touch(docId) {
    this.firebase.patchDoc(firebaseConfig.licencesCollection, docId, {
      lastSeenAt: new Date().toISOString()
    }).catch(() => {});
  }

  /**
   * Re-checks a cached licence when the internet happens to be available, so
   * a revoked or expired licence is noticed without the customer doing
   * anything. Silently does nothing when offline.
   */
  async recheck(force) {
    if (!this.store.activated) return { changed: false };
    if (!force && !this.store.shouldRecheck()) return { changed: false };

    const model = this.model;
    const docId = model.keyToDocId(this.store.key);
    try {
      const record = await this.firebase.getDoc(firebaseConfig.licencesCollection, docId);
      if (!record) {
        // The record is gone. Keep working until the grace period runs out
        // rather than locking a paying customer out over a console mistake.
        console.warn('[licence] the licence record no longer exists upstream.');
        return { changed: false, missing: true };
      }
      record.key = model.formatKey(this.store.key);
      this.store.refresh(record);
      this._touch(docId);
      return { changed: true, record };
    } catch (err) {
      if (!err.offline) console.warn('[licence] re-check failed:', err.message);
      return { changed: false, offline: !!err.offline };
    }
  }

  /** The single answer the rest of the app asks for. */
  status() {
    const model = this.model;
    const base = {
      machineCode: this.machineCode,
      activatedAt: this.store.activatedAt,
      lastVerifiedAt: this.store.lastVerifiedAt,
      daysSinceVerified: this.store.daysSinceVerified(),
      recheckDays: RECHECK_DAYS,
      graceDays: GRACE_DAYS
    };

    if (this.store.tampered) {
      return Object.assign(base, {
        ok: false, licensed: false, status: 'tampered',
        message: 'The stored licence does not belong to this computer. Please activate again.',
        details: null
      });
    }

    if (!this.store.activated) {
      return Object.assign(base, {
        ok: false, licensed: false, status: model.STATUS.NONE,
        message: 'Enter the licence key supplied with your purchase to start using the software.',
        details: null
      });
    }

    const record = this.store.record;
    const verdict = model.evaluateRecord(record, this.machineId);

    if (!verdict.ok) {
      return Object.assign(base, {
        ok: false, licensed: false, status: verdict.status,
        message: verdict.message,
        details: model.describeRecord(record)
      });
    }

    // Gone too long without a re-check: ask for internet once.
    if (this.store.pastGrace()) {
      return Object.assign(base, {
        ok: false, licensed: false, status: 'recheck_required',
        message: `This copy has not been able to check its licence for ${this.store.daysSinceVerified()} days. Connect to the internet once so it can confirm, then it will go back to working offline.`,
        details: model.describeRecord(record)
      });
    }

    const details = model.describeRecord(record);
    return Object.assign(base, {
      ok: true, licensed: true,
      status: verdict.status,
      message: verdict.message,
      daysLeft: verdict.daysLeft,
      expiringSoon: !!verdict.expiringSoon,
      details,
      features: details.features,
      limits: { maxUnits: details.maxUnits, maxUsers: details.maxUsers }
    });
  }

  deactivate() {
    this.store.clear();
    return this.status();
  }
}

module.exports = { LicenceService };
