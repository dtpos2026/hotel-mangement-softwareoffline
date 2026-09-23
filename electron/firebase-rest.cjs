/**
 * Firestore access over REST, from the main process.
 *
 * Deliberately not the Firebase SDK. The SDK would have to be loaded into the
 * renderer from a CDN — which an offline-first product cannot rely on — and
 * would put licence checking inside page JavaScript. Plain REST calls from the
 * main process need no dependency, work the moment there is internet, and keep
 * verification out of the page.
 *
 * Auth is Firebase Anonymous Authentication, so Firestore rules can require a
 * signed-in caller rather than being open to the world.
 */

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const FIRESTORE = 'https://firestore.googleapis.com/v1';
const TIMEOUT_MS = 15000;

class FirebaseRest {
  constructor(config) {
    this.config = config || {};
    this.token = null;
    this.tokenExpiry = 0;
  }

  get configured() {
    return !!(this.config.apiKey && this.config.projectId);
  }

  async _fetch(url, options, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({ signal: controller.signal }, options));
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
      if (!res.ok) {
        const raw = (body && body.error && body.error.message) || `HTTP ${res.status}`;
        const err = new Error(explain(raw, label, res.status));
        err.status = res.status;
        err.firebaseCode = body && body.error && body.error.status;
        err.raw = raw;
        throw err;
      }
      return body;
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error('No response from the internet. Check the connection and try again.');
        e.offline = true;
        throw e;
      }
      if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH/i.test(err.message)) {
        const e = new Error('No internet connection.');
        e.offline = true;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Anonymous sign-in, cached until shortly before it expires. */
  async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiry - 60000) return this.token;
    const body = await this._fetch(
      `${IDENTITY}/accounts:signUp?key=${encodeURIComponent(this.config.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }) },
      'Sign-in'
    );
    this.token = body.idToken;
    this.tokenExpiry = Date.now() + (Number(body.expiresIn || 3600) * 1000);
    return this.token;
  }

  _docUrl(collection, id) {
    return `${FIRESTORE}/projects/${encodeURIComponent(this.config.projectId)}` +
           `/databases/(default)/documents/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
  }

  async getDoc(collection, id) {
    const token = await this.ensureToken();
    try {
      const body = await this._fetch(this._docUrl(collection, id),
        { headers: { Authorization: 'Bearer ' + token } }, 'Lookup');
      return fromFirestore(body.fields || {});
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /** Patches only the named fields, leaving the rest of the document alone. */
  async patchDoc(collection, id, fields) {
    const token = await this.ensureToken();
    const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const body = await this._fetch(`${this._docUrl(collection, id)}?${mask}`,
      {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: toFirestore(fields) })
      }, 'Update');
    return fromFirestore(body.fields || {});
  }
}

/* ------------------------------------------------------------ messages */

/**
 * Turns a Firebase error into something a hotel owner can act on.
 *
 * These reach the activation screen, so "ADMIN_ONLY_OPERATION" is not good
 * enough: it is what Identity Toolkit returns when Anonymous sign-in is
 * switched off in the project, which is a setting somebody has to go and
 * turn on. Saying so is the difference between a five-minute fix and a
 * support call.
 */
function explain(raw, label, status) {
  const code = String(raw).split(' : ')[0].trim();

  if (code === 'ADMIN_ONLY_OPERATION' || /ADMIN_ONLY_OPERATION/.test(raw)) {
    return 'The licence server is not finished being set up: Anonymous sign-in is switched off for this Firebase project. ' +
           'In the Firebase console open Authentication, then Sign-in method, and enable Anonymous. ' +
           'Activation will work straight away after that.';
  }
  if (code === 'OPERATION_NOT_ALLOWED' || /OPERATION_NOT_ALLOWED/.test(raw)) {
    return 'The licence server refused the sign-in method it uses. In the Firebase console, under Authentication then Sign-in method, enable Anonymous.';
  }
  if (code === 'API_KEY_INVALID' || /API key not valid/i.test(raw)) {
    return 'This copy was built with licence server details that are no longer valid. Contact your supplier.';
  }
  if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
    return 'The licence server is busy. Wait a few minutes and try to activate again.';
  }
  if (status === 403 || /PERMISSION_DENIED/i.test(raw)) {
    return 'The licence server refused the request. Its security rules may not be published yet — contact your supplier.';
  }
  if (status === 404 && label === 'Lookup') {
    // A missing document is a missing licence, handled by the caller.
    return raw;
  }
  return `${label} failed: ${raw}`;
}

/* ------------------------------------------------- value conversion */

function toFirestoreValue(v) {
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

function toFirestore(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = toFirestoreValue(obj[k]);
  return out;
}

function fromFirestoreValue(v) {
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

function fromFirestore(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = fromFirestoreValue(fields[k]);
  return out;
}

module.exports = { FirebaseRest, toFirestore, fromFirestore };
