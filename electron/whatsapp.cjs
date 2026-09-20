/**
 * WhatsApp linking and sending.
 *
 * Uses Baileys, which speaks WhatsApp's own multi-device protocol over a
 * WebSocket. Chosen over the Puppeteer-based clients because it needs no
 * second Chromium — the installer is already large enough — and because it
 * survives on the low-spec machines these properties run.
 *
 * IMPORTANT, and surfaced in the UI as well: this is an unofficial client.
 * WhatsApp does not support third-party software, and a number that blasts
 * unsolicited messages will be banned. The guardrails here — a per-message
 * delay, an hourly cap and a daily cap — exist because a banned number is a
 * far worse outcome for a hotel than a slow queue.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

/** Pacing. Deliberately conservative; a hotel sends tens, not thousands. */
const MIN_GAP_MS = 4000;
const HOURLY_CAP = 40;
const DAILY_CAP = 250;

class WhatsAppService extends EventEmitter {
  constructor(userDataPath) {
    super();
    this.authDir = path.join(userDataPath, 'whatsapp-session');
    this.statsFile = path.join(userDataPath, 'whatsapp-stats.json');
    this.sock = null;
    this.state = 'disconnected';   // disconnected | connecting | qr | connected
    this.qr = '';                  // data URL
    this.me = null;                // { id, name }
    this.lastError = '';
    this.lastSentAt = 0;
    this.stopping = false;
    this.stats = this._readStats();
  }

  /* ------------------------------------------------------------- stats */

  _readStats() {
    try {
      if (fs.existsSync(this.statsFile)) return JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
    } catch { /* start fresh */ }
    return { sent: [], totalSent: 0 };
  }

  _saveStats() {
    try {
      // Only the last day of timestamps is needed for the caps.
      const cutoff = Date.now() - 86400000;
      this.stats.sent = (this.stats.sent || []).filter(t => t > cutoff);
      fs.mkdirSync(path.dirname(this.statsFile), { recursive: true });
      fs.writeFileSync(this.statsFile, JSON.stringify(this.stats), 'utf8');
    } catch { /* stats are not worth failing a send over */ }
  }

  usage() {
    const now = Date.now();
    const sent = this.stats.sent || [];
    return {
      lastHour: sent.filter(t => t > now - 3600000).length,
      lastDay: sent.filter(t => t > now - 86400000).length,
      total: this.stats.totalSent || 0,
      hourlyCap: HOURLY_CAP,
      dailyCap: DAILY_CAP
    };
  }

  /* -------------------------------------------------------- connection */

  status() {
    return {
      state: this.state,
      qr: this.qr,
      me: this.me,
      linked: this.state === 'connected',
      hasSession: fs.existsSync(this.authDir),
      lastError: this.lastError,
      usage: this.usage()
    };
  }

  _emitStatus() { this.emit('status', this.status()); }

  /** Starts the socket and, if unlinked, produces a QR code to scan. */
  async connect() {
    if (this.sock && this.state === 'connected') return this.status();
    this.stopping = false;
    this.lastError = '';
    this.state = 'connecting';
    this._emitStatus();

    let baileys, qrcode;
    try {
      baileys = await import('baileys');
      qrcode = require('qrcode');
    } catch (err) {
      this.state = 'disconnected';
      this.lastError = 'WhatsApp support is not installed in this build: ' + err.message;
      this._emitStatus();
      return this.status();
    }

    const makeWASocket = baileys.makeWASocket || baileys.default;
    const { useMultiFileAuthState, DisconnectReason, Browsers } = baileys;

    try {
      fs.mkdirSync(this.authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers ? Browsers.appropriate('Hotel Register') : ['Hotel Register', 'Desktop', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,   // do not steal notifications from the phone
        generateHighQualityLinkPreview: false
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qr = await qrcode.toDataURL(qr, { margin: 1, width: 320,
              color: { dark: '#16202A', light: '#FFFFFF' } });
            this.state = 'qr';
            this._emitStatus();
          } catch (err) {
            this.lastError = 'Could not draw the QR code: ' + err.message;
            this._emitStatus();
          }
        }

        if (connection === 'open') {
          this.state = 'connected';
          this.qr = '';
          this.lastError = '';
          const user = this.sock.user || {};
          this.me = { id: user.id || '', name: user.name || user.verifiedName || '' };
          this._emitStatus();
        }

        if (connection === 'close') {
          const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
            ? lastDisconnect.error.output.statusCode : null;
          const loggedOut = DisconnectReason && code === DisconnectReason.loggedOut;

          this.state = 'disconnected';
          this.me = null;

          if (loggedOut) {
            // The phone unlinked this device; the stored session is useless.
            this.lastError = 'WhatsApp was unlinked from the phone. Scan the QR code again to reconnect.';
            this._clearSession();
            this._emitStatus();
            return;
          }

          if (!this.stopping) {
            this.lastError = 'Connection lost. Reconnecting…';
            this._emitStatus();
            setTimeout(() => { if (!this.stopping) this.connect().catch(() => {}); }, 4000);
          } else {
            this._emitStatus();
          }
        }
      });

      return this.status();
    } catch (err) {
      this.state = 'disconnected';
      this.lastError = err.message;
      this._emitStatus();
      return this.status();
    }
  }

  async disconnect() {
    this.stopping = true;
    try { if (this.sock) await this.sock.end(); } catch { /* already gone */ }
    this.sock = null;
    this.state = 'disconnected';
    this.qr = '';
    this.me = null;
    this._emitStatus();
    return this.status();
  }

  /** Unlinks and forgets the session, so the next connect shows a fresh QR. */
  async unlink() {
    this.stopping = true;
    try { if (this.sock) await this.sock.logout(); } catch { /* may already be gone */ }
    try { if (this.sock) await this.sock.end(); } catch { /* ignore */ }
    this.sock = null;
    this._clearSession();
    this.state = 'disconnected';
    this.qr = '';
    this.me = null;
    this._emitStatus();
    return this.status();
  }

  _clearSession() {
    try { fs.rmSync(this.authDir, { recursive: true, force: true }); }
    catch (err) { console.warn('[whatsapp] could not clear the session:', err.message); }
  }

  /* ------------------------------------------------------------ sending */

  /**
   * Turns a Pakistani number into WhatsApp's format.
   * 0300-1234567 and +92 300 1234567 both become 923001234567.
   */
  static toJid(phone, defaultCountry) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    const cc = String(defaultCountry || '92');

    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = cc + digits.slice(1);
    else if (digits.length <= 10) digits = cc + digits;

    // A real mobile number, once the country code is on, is 11–15 digits.
    if (digits.length < 11 || digits.length > 15) return null;
    return digits + '@s.whatsapp.net';
  }

  _capCheck() {
    const usage = this.usage();
    if (usage.lastHour >= HOURLY_CAP) {
      return `The hourly limit of ${HOURLY_CAP} messages has been reached. This limit exists to keep the number from being blocked by WhatsApp. Try again later.`;
    }
    if (usage.lastDay >= DAILY_CAP) {
      return `The daily limit of ${DAILY_CAP} messages has been reached. This limit exists to keep the number from being blocked by WhatsApp.`;
    }
    return null;
  }

  async send(phone, text, opts) {
    const o = opts || {};
    if (this.state !== 'connected' || !this.sock) {
      return { ok: false, message: 'WhatsApp is not linked. Open Settings → WhatsApp and scan the QR code.' };
    }
    const body = String(text || '').trim();
    if (!body) return { ok: false, message: 'The message is empty.' };

    const jid = WhatsAppService.toJid(phone, o.countryCode);
    if (!jid) return { ok: false, message: `"${phone}" is not a usable mobile number.` };

    const capped = this._capCheck();
    if (capped) return { ok: false, message: capped, rateLimited: true };

    // Space messages out. Sending in a burst is the single most reliable way
    // to get a number flagged.
    const wait = MIN_GAP_MS - (Date.now() - this.lastSentAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    try {
      // Confirm the number is actually on WhatsApp before sending, so a typo
      // does not become a message into the void.
      if (this.sock.onWhatsApp) {
        try {
          const [found] = await this.sock.onWhatsApp(jid.split('@')[0]);
          if (found && found.exists === false) {
            return { ok: false, message: `${phone} is not registered on WhatsApp.` };
          }
        } catch { /* the check is a courtesy; carry on if it fails */ }
      }

      await this.sock.sendMessage(jid, { text: body });

      this.lastSentAt = Date.now();
      this.stats.sent = (this.stats.sent || []).concat([Date.now()]);
      this.stats.totalSent = (this.stats.totalSent || 0) + 1;
      this._saveStats();

      return { ok: true, to: jid.split('@')[0], usage: this.usage() };
    } catch (err) {
      return { ok: false, message: 'Could not send: ' + err.message };
    }
  }
}

module.exports = { WhatsAppService, MIN_GAP_MS, HOURLY_CAP, DAILY_CAP };
