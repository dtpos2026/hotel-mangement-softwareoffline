/**
 * Printing plumbing.
 *
 * Everything printable is produced as a complete, self-contained HTML document
 * string. That document is then either written into a hidden iframe and printed
 * (no popup blocker, no second window to close) or shown in the preview modal.
 *
 * Browsers cannot enumerate system printers, so "printer selection" is the
 * operating system's own print dialog. What the app does control — and what
 * actually matters on an 80mm till printer — is the page geometry: width,
 * the four margins, font size and logo size, all of which are settings.
 */

const FRAME_ID = 'hms-print-frame';

/** Shared reset used by every printed document. */
export function printBase() {
  return `
    *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    html,body{margin:0;padding:0;background:#fff;color:#000}
    img{max-width:100%}
    table{border-collapse:collapse;width:100%}
  `;
}

export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Prints a document string.
 *
 * The iframe is kept until afterprint (or a timeout) because Chrome tears down
 * the print job if its source frame is removed too early.
 */
export function printDocument(html, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const old = document.getElementById(FRAME_ID);
    if (old) old.remove();

    const frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);

    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      setTimeout(() => { const f = document.getElementById(FRAME_ID); if (f) f.remove(); }, 1200);
      err ? reject(err) : resolve();
    };

    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        const doPrint = () => {
          try {
            win.focus();
            if (win.matchMedia) {
              const mql = win.matchMedia('print');
              if (mql.addEventListener) mql.addEventListener('change', e => { if (!e.matches) finish(); });
            }
            win.addEventListener('afterprint', () => finish());
            const copies = Math.max(1, Number(o.copies) || 1);
            for (let i = 0; i < copies; i++) win.print();
            // Safari and some drivers never fire afterprint.
            setTimeout(() => finish(), 8000);
          } catch (err) { finish(err); }
        };
        // Give embedded images (the logo) a moment to decode.
        const images = Array.from(win.document.images || []);
        if (!images.length || images.every(i => i.complete)) setTimeout(doPrint, 60);
        else {
          let left = images.filter(i => !i.complete).length;
          const tick = () => { if (--left <= 0) setTimeout(doPrint, 40); };
          images.forEach(i => { if (!i.complete) { i.onload = tick; i.onerror = tick; } });
          setTimeout(doPrint, 2500);
        }
      } catch (err) { finish(err); }
    };

    const doc = frame.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
  });
}

/** Opens the document in a new tab — used by "Open in new window" on preview. */
export function openDocument(html) {
  const win = window.open('', '_blank');
  if (!win) throw new Error('The browser blocked the print window. Allow pop-ups for this page, or use Print instead.');
  win.document.open();
  win.document.write(html);
  win.document.close();
  return win;
}

/** Print settings, with every value clamped to something a printer can use. */
export function printerSettings(store) {
  const s = store.setting('printer');
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    widthMm:        clamp(s.widthMm, 40, 120, 80),
    marginLeftMm:   clamp(s.marginLeftMm, 0, 20, 4),
    marginRightMm:  clamp(s.marginRightMm, 0, 20, 4),
    marginTopMm:    clamp(s.marginTopMm, 0, 30, 3),
    marginBottomMm: clamp(s.marginBottomMm, 0, 40, 6),
    fontSizePt:     clamp(s.fontSizePt, 7, 16, 11),
    compactFontSizePt: clamp(s.compactFontSizePt, 6, 14, 10),
    logoSizePx:     clamp(s.logoSizePx, 32, 240, 96),
    showLogo:       s.showLogo !== false,
    template:       String(s.template || 'classic'),
    mode:           s.mode === 'compact' ? 'compact' : 'normal',
    copies:         clamp(s.copies, 1, 5, 1),
    printerName:    String(s.printerName || ''),
    silentPrint:    !!s.silentPrint,
    a4MarginMm:     clamp(s.a4MarginMm, 5, 30, 12)
  };
}

/** Usable content width after margins — what the receipt body is laid out in. */
export function contentWidthMm(settings) {
  return Math.max(20, settings.widthMm - settings.marginLeftMm - settings.marginRightMm);
}
