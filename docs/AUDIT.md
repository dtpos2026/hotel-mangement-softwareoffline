# Phase 1 — Audit of the existing prototype

Source inspected: `Hotel Register.dc.html` (1,117 lines) + `support.js` (1,911 lines) +
`uploads/688805644_...jpg`. Both files are preserved untouched under `_prototype/`.

## 1. What the prototype is

`Hotel Register.dc.html` is a **design comp**, not an application. It is written for a
template runtime (`<x-dc>`, `<sc-if>`, `<sc-for>`, `{{ binding }}`) whose implementation is
`support.js`.

`support.js` contains **no hotel logic at all** (0 occurrences of hotel/guest/room/invoice).
Its module map is `react.ts, parse.ts, boot.ts, expr.ts, encode.ts, compile.ts, logic.ts,
component.ts, bundled.ts, cdn.ts, external.ts, atomics.ts, helmet.ts, pseudo.ts, registry.ts,
runtime.ts, stream-state.ts, index.ts` — a generic template compiler and renderer.

All of the application's own JavaScript is the ~370-line `<script type="text/x-dc">` block at
line 745, a single `class Component extends DCLogic` with a `renderVals()` method.

## 2. Blocking defects found

| # | Defect | Severity |
|---|--------|----------|
| 1 | `support.js` fetches React, ReactDOM and Babel from `unpkg.com` at boot (`cdn.ts`, lines 1143–1180). **The app cannot start without internet.** | Fatal for an offline product |
| 2 | Fonts load from `fonts.googleapis.com`. Offline, the Urdu Nastaliq font silently disappears. | High |
| 3 | **Zero persistence.** No `localStorage`, no `indexedDB`, no file I/O. Every value is a hardcoded array (`ROOMS`, `inHouseRaw`, `regRaw`, `folioRaw`, `recentRaw`). Reload = total data loss. | Fatal |
| 4 | **No printing implementation.** "Print guest bill (80mm)", "Print register (A4)", "Print clearance slip" are buttons with no `onClick`. No `@media print`, no receipt template, no printer settings. | Fatal (this is a headline requirement) |
| 5 | No double-booking protection — no date model at all; dates are display strings (`'03 Aug'`). | Fatal |
| 6 | Money is strings (`rate: '14,000'`) parsed with `Number(String(v).replace(/[^0-9.]/g,''))`. Float arithmetic on currency. | High |
| 7 | 6 of 12 nav screens (Bookings, Restaurant, Payments, Expenses, Reports, Settings) are static text placeholders in the `PLACEHOLDER` map. | — |
| 8 | Every style is an inline `style=""` attribute — ~1,100 lines of duplicated declarations, no design tokens, no hover/focus/disabled states, no responsive rules. | Medium |
| 9 | Only the room grid is data-driven; guest/folio/register tables are literal row arrays. | Medium |
| 10 | Fixed date "05 Aug 2026 · Tue" hardcoded in the header. | Low |

## 3. What genuinely works and must NOT be lost

These are real design assets and were carried forward verbatim:

- **Visual identity** — aubergine sidebar `#1A0730` / `#150527`, brass-purple accent `#3C096C`,
  deodar green `#1F3A2E` / `#4B7F52`, river blue `#2C6E8F`, dirty amber `#C98A16`,
  due red `#B3261E`, hairline `#E2E6E4`, canvas `#F4F6F5`, ink `#16202A`.
- **Typography system** — Plus Jakarta Sans for UI, IBM Plex Mono with `tabular-nums` for all
  figures/dates/serials, Noto Nastaliq Urdu for Urdu. Uppercase 12px `0.06em` label style.
- **Bilingual nav** — English label + Urdu label on every nav row, and the `dir` flip with the
  `unicode-bidi: isolate` rule that keeps ledger numbers LTR inside an RTL page. This is a
  genuinely well-solved detail and is preserved in `styles/app.css`.
- **The Register (روزنامچہ)** — the Pakistani police/guest register with its exact 16 columns
  (S.No, Date, Time, Guest, CNIC, Room, Persons, Coming from, Going to, Vehicle, In, Out,
  Charges, Paid, Balance, Cleared). This is a legal requirement for Pakistani properties and is
  the single most domain-specific thing in the prototype. Rebuilt as a live, printable screen.
- **Room board layout** — floor sections, 148px room cards with a 4px status stripe, sticky
  detail rail.
- **Check-in form shape** — A · Guest details / B · Accompanying persons / C · Stay details,
  with the live bill summary rail. Field set (Coming from, Going to, Vehicle number, Purpose)
  is Pakistan-specific and kept.
- **Status vocabulary and colours**, the status strip bar, KPI card shape, quick actions.
- **Pakistani payment methods** — Cash, Easypaisa, JazzCash, Bank transfer, Card.
- **Digital Target branding block** in the sidebar footer, and the logo file.
- **Keyboard shortcuts** advertised in the sidebar (F2 / F4 / F8 / ⌘K) — now actually bound.

## 4. Decision

The prototype is a **specification in pixel form**, not a codebase to refactor: there is no
business logic to preserve, and its runtime is disqualified by requirement 28 (offline).

So: the *design* is preserved and extended; the *runtime* is replaced with a zero-dependency,
zero-build, fully offline ES-module application. Nothing that worked was thrown away, because
the only things that worked were visual.

## 5. Architecture adopted

```
index.html          single shell, no build step, no npm, no CDN, no network calls
styles/             design tokens (extracted from the prototype's inline styles) + print CSS
src/core/           storage engine, schema+migrations, repositories, ids, money, dates,
                    validation, i18n, auth/permissions, backup, audit log, events
src/domain/         business logic — pure, UI-free, independently testable
src/ui/             shell, router, reusable components, screens
src/print/          80mm thermal renderer, A4 renderer, printer settings
```

- **Storage**: IndexedDB primary, `localStorage` adapter as automatic fallback (Chrome blocks
  IndexedDB on `file://`), behind one `Database` interface. Single-writer transaction queue,
  snapshot + journal, integrity check on boot.
- **Money**: integer rupees only. No floats anywhere in the financial path.
- **Layering**: UI never touches storage. UI → domain service → repository → database.
  This is what keeps a future cloud-sync module additive rather than a rewrite.
- **Immutability of history**: reservations freeze their rate snapshot at creation; invoices
  freeze their line snapshot at issue; payments are append-only with voids, never edits.
