# Hotel Register — Offline Accommodation Management

An offline management system for hotels, guest houses, resorts, apartments,
villas, cottages and shared beds. Everything runs in the browser on one
computer: no server, no account, no internet, no build step and no dependencies.

Built for Pakistani properties — CNIC handling, Easypaisa and JazzCash, the
statutory guest register (روزنامچہ), 80mm thermal receipts and a bilingual
English/Urdu interface.

---

## Running it

Double-clicking `index.html` works, but the browser then blocks IndexedDB and
the app falls back to smaller browser storage. **Serve the folder instead** —
it takes one command and gives you the full local database:

```bash
npx http-server -p 8080 .        # then open http://127.0.0.1:8080
# or
python3 -m http.server 8080
```

The title bar tells you which storage engine is in use; Settings › About
states it in full and warns when the fallback is active.

First launch asks for the property name and type, and offers sample data so
every screen has something in it. The sample data can be erased at any time
from Settings › About.

The default user is **Administrator** with PIN **1234** — change it in
Settings › Users.

## Keyboard

| Key | Action |
|-----|--------|
| `F2` | Check in |
| `F4` | Check out |
| `F8` | Guest register |
| `F9` | Availability calendar |
| `Ctrl/⌘ K` or `/` | Global search |

## Printing

**80mm thermal.** Settings › Receipt & printer controls paper width, all four
margins independently, font size and logo size, with a live diagram of the
print area. Defaults are 80mm paper with equal 4mm side margins, giving a 72mm
print area — the width an 80mm head actually images, centred on the roll.

*Compact mode* prints the same content about 35% shorter for properties that
want to save paper. It stays at 10pt and uses no dotted or hairline text.

**Four receipt designs** — Classic, Banded, Letterhead and Minimal — change the
letterhead only: the logo, the property name and the address, set in Settings ›
Property. Every figure, column and total is identical in all four, so changing
the look cannot change what a receipt says. Pick one in Settings › Receipt &
printer, where a real 80mm receipt is previewed beside the choices and can be
printed on the actual printer before it is saved.

Use **Test print** after any change: it prints a ruler with edge arrows, so
clipping is obvious at a glance.

In the browser's print dialog set **Margins: None**, **Headers and footers:
off**, **Scale: 100%**. Set the thermal printer as the system default for
one-click printing — browsers cannot choose a printer for you, which is why
the printer name field here is only a note for staff.

## Stock and purchasing

Switched on in Settings › Stock, like the restaurant module. It adds a **Stock**
entry to the sidebar with three tabs: what is on the shelves, what was bought,
and what each supplier is owed.

Stock on hand is never stored as a number — it is the sum of the movements, so
a balance cannot drift away from the history that produced it. A stock take
writes a correcting movement rather than overwriting a figure. Every movement
freezes its own cost, so what a bag of rice cost in March stays what March's
consumption was worth. Recording a delivery writes the bill, its lines and one
stock movement per line in a single transaction: a purchase can never exist
without the stock it brought in.

Cancelling a purchase puts its stock back, and is refused when any of that
stock has already been used — reversing it would make the history describe
something that never happened.

Four more reports — stock on hand, purchases, supplier balances and stock
consumed — appear on the Reports screen once the module is on, and disappear
with it. They share the shape every other report uses, so they export to CSV
and print on A4 with no special casing.

**A4.** Invoices, registration cards, day-close reports and all seventeen
reports. Reports are paginated in code, so "Page 2 of 5", the column header and
the property masthead repeat properly on every sheet.

## Backup

Everything lives on this one computer. **Download a backup at the end of each
day** from Settings › Backup & restore and keep it somewhere else.

A restore validates the whole file before writing anything, takes a copy of the
current data first, and downloads that copy as a precaution. A bad file changes
nothing. A local safety copy is also taken automatically once a day, but it
lives in the browser and will not survive a reinstall — the downloaded file is
the one that matters.

## What it does

Property profile · unit types · units with rates, capacity and amenities ·
guests with stay history and duplicate protection · reservations with hard
double-booking prevention · availability calendar · one-page walk-in check-in ·
folio and extra charges · append-only payment ledger · check-out with
settlement · housekeeping lifecycle · maintenance blocks · expenses · thirteen
reports with CSV export · daily closing that locks its figures · five roles
with an explicit permission set · English/Urdu.

## Architecture

```
index.html          the whole app; ES modules, no bundler
styles/app.css      design tokens and components
src/core/           storage, schema, money, dates, validation, auth, i18n, backup
src/domain/         business logic — no DOM, independently testable
src/ui/             shell, components, screens
src/print/          80mm and A4 renderers
tests/              404 automated checks
```

Three rules hold the product together:

1. **UI never touches storage.** UI → domain service → repository → database.
   This is what lets a cloud-sync module be added later beside the domain layer
   rather than through it.
2. **Money is integer rupees.** No floating point anywhere in the financial
   path.
3. **History is immutable.** A reservation freezes its rate at creation, an
   invoice freezes its lines at check-out, payments are append-only with voids,
   and a closed day locks the receipts inside it. Changing a price today cannot
   alter what an old invoice says.

`docs/AUDIT.md` records what the original prototype was and why the runtime
was replaced while the design was kept.

## Licensing

The software will not open until it has been activated with a key. Keys are
issued from a web panel in `admin-panel/`, hosted on Firebase, and verified
against Firestore once — after that a copy runs entirely offline, for 45 days
without seeing the internet at all.

```bash
npm run panel          # the licence panel at http://127.0.0.1:7788
npm run deploy:panel   # publish the panel and the Firestore rules
npm run test:panel     # drive the whole panel with Firebase stubbed out
```

Licences can be **suspended** (a reversible hold), **revoked** (the end of the
sale, still reactivatable) or **resumed**. A running copy asks the server every
fifteen minutes, on every start, and when the machine wakes — so a suspension
locks the software within about a quarter of an hour, showing the Digital
Target number and saying plainly that the data is untouched.

`docs/LICENSING.md` has the one-time Firebase setup, how a licence behaves,
how to move a customer to a new computer, and why the API key in the installer
is not a secret.

## Tests

```bash
npm test                                  # 765 checks, no browser needed
npx http-server -p 8765 -s . &            # then, for the browser suites:
node tests/browser.test.mjs               # 155 checks in real Chromium
npm run test:panel                        # 104 checks, serves itself
```

- `tests/run.js` — the 29-point acceptance checklist against the domain layer.
- `tests/print.test.js` — every required receipt and invoice field, the 80mm
  geometry maths, compact-mode savings, pagination, HTML escaping.
- `tests/integration.test.js` — the demo seed end to end, all reports, the
  whole UI module graph, reload safety.
- `tests/browser.test.mjs` — real Chromium: IndexedDB, the booking form
  refusing a clash, a walk-in, the print pipeline, check-out with a balance,
  the Urdu switch, backup/restore, role permissions.
- `tests/inventory.test.js` — stock and purchasing: that a balance always
  equals the movements that produced it, that consumption keeps the cost it
  was made at, and that a purchase whose stock has been used cannot be
  reversed.
- `tests/panel.test.mjs` — the licence panel in Chromium with every Firebase
  call intercepted and answered in Firestore's own wire format, so issuing,
  renewing, revoking and releasing a licence are all covered without touching
  the real project.

The Node suites deliberately run on the localStorage adapter — the one that
ships for `file://` use — while the browser suite covers IndexedDB.

## Offline and fonts

No network request is required. `index.html` links Google Fonts as a pure
enhancement: online it loads the typefaces the design was drawn with, offline
the link fails silently and the local stacks take over. The Urdu stack names
the Nastaliq fonts actually installed on Pakistani Windows machines, starting
with Jameel Noori Nastaleeq, so Urdu keeps proper Nastaliq shaping with no
internet. See `docs/FONTS.md` to pin the typography completely offline.

## Not included, by design

No online booking, cloud sync, OTA integration, customer portal or online
payments. The architecture keeps room for them — the domain layer has no UI
and no storage assumptions — but none of it is built, and nothing offline
depends on it.

---

Software by **Digital Target**.
