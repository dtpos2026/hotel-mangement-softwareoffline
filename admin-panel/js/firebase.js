/**
 * Firebase access for the admin panel, over plain REST.
 *
 * No SDK and no CDN: the panel is three small files that load instantly and
 * keep working when gstatic.com is slow or blocked, which matters when the
 * person using it is on a phone tethered in a bazaar. It also means the panel
 * and the desktop app talk to Firestore the same way, so there is one set of
 * conversions to keep right rather than two.
 */

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1';
const FIRESTORE = 'https://firestore.googleapis.com/v1';
const TIMEOUT_MS = 20000;

/* The session lives in sessionStorage, so closing the tab signs you out. A
   shared laptop in an office is the normal case, not the exception. */
const SESSION_KEY = 'hms.panel.session';

export class Panel {
  constructor(config) {
    this.config = config;
    this.session = readSession();
  }

  get signedIn() { return !!(this.session && this.session.refreshToken); }
  get email() { return (this.session && this.session.email) || ''; }

  /* ------------------------------------------------------------- network */

  async _fetch(url, options, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({ signal: controller.signal }, options));
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
      if (!res.ok) {
        const raw = (body && body.error && body.error.message) || ('HTTP ' + res.status);
        const err = new Error(friendly(raw, label));
        err.status = res.status;
        err.raw = raw;
        throw err;
      }
      return body;
    } catch (err) {
      if (err.name === 'AbortError') throw offlineError();
      if (/Failed to fetch|NetworkError|ENOTFOUND|ECONNREFUSED/i.test(err.message)) throw offlineError();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------- auth */

  async signIn(email, password) {
    const body = await this._fetch(
      `${IDENTITY}/accounts:signInWithPassword?key=${encodeURIComponent(this.config.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(email || '').trim(), password: String(password || ''), returnSecureToken: true }) },
      'sign-in'
    );
    this.session = {
      email: body.email,
      idToken: body.idToken,
      refreshToken: body.refreshToken,
      expiresAt: Date.now() + (Number(body.expiresIn || 3600) * 1000),
      localId: body.localId
    };
    writeSession(this.session);
    return this.session;
  }

  signOut() {
    this.session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
  }

  /** Sends the "reset your password" email Firebase already knows how to send. */
  async sendPasswordReset(email) {
    await this._fetch(
      `${IDENTITY}/accounts:sendOobCode?key=${encodeURIComponent(this.config.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: String(email || '').trim() }) },
      'reset'
    );
  }

  async changePassword(newPassword) {
    const token = await this.token();
    const body = await this._fetch(
      `${IDENTITY}/accounts:update?key=${encodeURIComponent(this.config.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token, password: String(newPassword), returnSecureToken: true }) },
      'password change'
    );
    if (body.idToken) {
      this.session.idToken = body.idToken;
      this.session.refreshToken = body.refreshToken || this.session.refreshToken;
      this.session.expiresAt = Date.now() + (Number(body.expiresIn || 3600) * 1000);
      writeSession(this.session);
    }
  }

  /** A valid ID token, refreshing it when it is close to expiring. */
  async token() {
    if (!this.session) throw new Error('Signed out.');
    if (this.session.idToken && Date.now() < this.session.expiresAt - 60000) return this.session.idToken;

    const body = await this._fetch(
      `${SECURE_TOKEN}/token?key=${encodeURIComponent(this.config.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(this.session.refreshToken) },
      'session refresh'
    );
    this.session.idToken = body.id_token;
    this.session.refreshToken = body.refresh_token || this.session.refreshToken;
    this.session.expiresAt = Date.now() + (Number(body.expires_in || 3600) * 1000);
    writeSession(this.session);
    return this.session.idToken;
  }

  /* ----------------------------------------------------------- firestore */

  _base() {
    return `${FIRESTORE}/projects/${encodeURIComponent(this.config.projectId)}/databases/(default)/documents`;
  }

  async _auth() {
    return { Authorization: 'Bearer ' + (await this.token()) };
  }

  async getDoc(collection, id) {
    try {
      const body = await this._fetch(`${this._base()}/${collection}/${encodeURIComponent(id)}`,
        { headers: await this._auth() }, 'lookup');
      return fromFirestore(body.fields || {});
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Creates a document at a chosen id. Firestore answers 409 when the id is
   * taken, which is how key collisions are caught — a check-then-write would
   * leave a gap two admins could both walk through.
   */
  async createDoc(collection, id, data) {
    const body = await this._fetch(
      `${this._base()}/${collection}?documentId=${encodeURIComponent(id)}`,
      { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, await this._auth()),
        body: JSON.stringify({ fields: toFirestore(data) }) },
      'create'
    );
    return fromFirestore(body.fields || {});
  }

  /** Patches only the named fields, leaving everything else alone. */
  async patchDoc(collection, id, fields) {
    const mask = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
    const body = await this._fetch(
      `${this._base()}/${collection}/${encodeURIComponent(id)}?${mask}`,
      { method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, await this._auth()),
        body: JSON.stringify({ fields: toFirestore(fields) }) },
      'update'
    );
    return fromFirestore(body.fields || {});
  }

  async deleteDoc(collection, id) {
    await this._fetch(`${this._base()}/${collection}/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: await this._auth() }, 'delete');
  }

  /**
   * Every licence, newest first. Ordering on one field needs no composite
   * index, and filtering happens in the panel — a vendor has hundreds of
   * licences, not millions, so one query beats a query per filter change.
   */
  async listLicences(limit) {
    const body = await this._fetch(`${this._base()}:runQuery`,
      { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, await this._auth()),
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: this.config.licencesCollection }],
            orderBy: [{ field: { fieldPath: 'issuedAt' }, direction: 'DESCENDING' }],
            limit: Number(limit) || 500
          }
        }) },
      'listing'
    );
    return (Array.isArray(body) ? body : [])
      .filter(row => row && row.document)
      .map(row => {
        const rec = fromFirestore(row.document.fields || {});
        rec.docId = String(row.document.name).split('/').pop();
        return rec;
      });
  }
}

/* --------------------------------------------------------------- helpers */

function offlineError() {
  const e = new Error('No internet connection. The panel needs to be online to reach Firebase.');
  e.offline = true;
  return e;
}

/** Firebase speaks in shouted constants; people do not. */
function friendly(raw, label) {
  const map = {
    EMAIL_NOT_FOUND: 'No panel account uses that email address.',
    INVALID_PASSWORD: 'That password is not right.',
    INVALID_LOGIN_CREDENTIALS: 'That email and password do not match an account.',
    INVALID_EMAIL: 'That is not a valid email address.',
    USER_DISABLED: 'That account has been disabled in the Firebase console.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.',
    WEAK_PASSWORD: 'Firebase needs a password of at least 6 characters.',
    TOKEN_EXPIRED: 'The session expired. Please sign in again.',
    INVALID_REFRESH_TOKEN: 'The session expired. Please sign in again.',
    CREDENTIAL_TOO_OLD_LOGIN_AGAIN: 'For this change, sign out and sign in again first.'
  };
  const code = String(raw).split(' : ')[0].trim();
  if (map[code]) return map[code];
  if (/PERMISSION_DENIED|Missing or insufficient permissions/i.test(raw)) {
    return 'Firestore refused that. This account is not on the admins list — add it in the Firebase console under the "admins" collection.';
  }
  if (/NOT_FOUND/i.test(raw) && label === 'listing') {
    return 'No licences have been created yet.';
  }
  return raw;
}

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeSession(session) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* private mode */ }
}

/* ------------------------------------------------- value conversion */

export function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = toFirestoreValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

export function toFirestore(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = toFirestoreValue(obj[k]);
  return out;
}

export function fromFirestoreValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) return fromFirestore(v.mapValue.fields || {});
  return null;
}

export function fromFirestore(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = fromFirestoreValue(fields[k]);
  return out;
}
