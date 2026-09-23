# Licensing and the admin panel

Hotel Register is sold, not given away. A copy will not open until it has been
activated with a licence key, and keys are issued from a web panel that only
Digital Target can sign into.

The whole system is three moving parts:

| Part | Where it runs | What it does |
|---|---|---|
| **Licence panel** | Firebase Hosting | Issues keys, renews and revokes them |
| **Firestore** | Google | Holds one document per licence |
| **The software** | The customer's Windows PC | Checks the key once, then runs offline |

---

## How a licence behaves

1. You create a licence in the panel. It gets a key like `HR-4F2K-9XQP-7M3A`
   and a document in the `licences` collection.
2. You send the key to the customer — the panel has a **Send on WhatsApp**
   button that writes the message for you.
3. The customer types it on the activation screen. The software checks it with
   Firestore **once**, over the internet.
4. On that first check the licence is stamped with the computer's machine code.
   From then on the key only works on that computer.
5. After activation the software works **entirely offline**. It re-checks in the
   background if it happens to have internet, at most once a week, and keeps
   working for 45 days without one. Only after 45 days offline does it ask for
   the internet again.

That last point is the whole design: a guest house in a valley with no signal
must keep taking bookings. Revoking a licence therefore takes effect the next
time that copy reaches the internet, not instantly.

### Moving a customer to a new computer

Open the licence, then **Release the computer**. The binding is cleared and the
next computer to enter the key claims it. Do this when a customer replaces a PC
— otherwise they will be told the licence is already in use elsewhere.

### Suspend, revoke or delete?

**Suspend** is the reversible hold — an unpaid instalment, a dispute. The
software locks with the Digital Target number on screen; nothing is deleted and
the customer gets everything back the moment you press Resume.

**Revoke** is the end of the sale — refunded, charged back, replaced. It can
still be reactivated if the customer comes back, and the record stays
searchable when they phone a year later.

**Delete** only removes your own history. Prefer the other two.

### How quickly does a change take effect?

The software is offline-first, so nothing is pushed to it. A running copy asks
the licence server every fifteen minutes, on every start, and again when the
computer wakes or the screen unlocks. So a suspension takes effect:

- **immediately** on the next start, and
- **within about fifteen minutes** on a copy that is already running and has
  internet.

A copy with no internet keeps working on its cached answer, which is the whole
point of the product; it stops the moment it next reaches the internet, and in
any case after 45 days without a check.

---

## Setting the project up (once)

You need the [Firebase CLI](https://firebase.google.com/docs/cli):

```bash
npm install -g firebase-tools
firebase login
```

### 1. Turn on the two sign-in methods

In the [Firebase console](https://console.firebase.google.com/) → your project →
**Authentication** → *Sign-in method*, enable **both**:

- **Email/Password** — how you sign into the panel.
- **Anonymous** — how an installed copy of the software reads its own licence
  without you handing out any credentials.

Miss the second one and activation fails on every customer's PC with
`ADMIN_ONLY_OPERATION`, which is Firebase's way of saying "nobody may create an
account here". The software now explains that in plain words on the activation
screen, but the fix is this setting.

### 2. Create your panel account

Authentication → *Users* → **Add user**. Use your Gmail address and whatever
password you like. This is the account and password you will use to sign in —
you can change the password from inside the panel afterwards.

### 3. Put yourself on the admins list

Firestore Database → **Start collection** → collection id `admins`. Add a
document whose **document ID is your email address**, exactly as you typed it
in step 2. The document does not need any fields — a note field is useful:

```
Collection: admins
Document ID: you@gmail.com
Fields:      name = "Your Name"   (optional)
```

Only an email on this list can list, create or change licences. Anyone else who
signs in gets a permission error and sees nothing. Remove a document here and
that person loses access on their next request.

### 4. Deploy the rules and the panel

```bash
npm run deploy:panel
```

Use that command rather than `firebase deploy` on its own: it copies the shared
files into `admin-panel/lib/` first. Those copies are committed, so a plain
`firebase deploy` works too — but only `npm run deploy:panel` guarantees they
match the current licence model.

That publishes `firestore.rules` and the panel itself. The panel is then at
`https://<project-id>.web.app`.

To publish only the rules after editing them:

```bash
npm run deploy:rules
```

---

## Checking the project before you sell

The panel signing in says nothing about whether a customer's software will:
the panel uses a password, the software signs in anonymously, and those are two
separate switches. **Server check** in the panel closes that gap — it does the
same anonymous sign-in a customer's copy does and reports whether activation
will work, so a missing setting is found in the panel rather than on somebody
else's PC.

## Running the panel locally

```bash
npm run panel          # http://127.0.0.1:7788
```

It talks to the real Firebase project, so anything you create locally is a real
licence. `npm run panel` also re-copies the shared files (see below) before
serving, so a local run can never be testing a stale copy of the licence model.

To exercise the panel without touching Firebase at all:

```bash
npm run test:panel     # drives the whole panel with Firebase stubbed out
```

---

## What is shared, and how

`tools/panel-sync.mjs` copies three files into `admin-panel/lib/` before the
panel is served or deployed:

| Source | Why it is shared |
|---|---|
| `src/core/licence-model.js` | Key format, plans, features, expiry rules |
| `src/ui/dom.js` | The `h()` helper |
| `electron/firebase-config.cjs` | The project the panel and the app both use |

The copies are generated and are not committed — the originals are the only
place to edit. This is what stops the panel issuing keys in a format the
software cannot read, or pointing at a different Firebase project than the
copies it licenses.

---

## Is the API key a secret?

No, and it does not need to be. A Firebase web API key identifies a project; it
authorises nothing. Anyone can extract it from the installer, and that gets them
exactly as far as an anonymous sign-in gets them.

What actually protects the licences is `firestore.rules`:

- **Listing every licence** requires an email on the `admins` list.
- **Creating, editing or deleting** a licence requires the same.
- An anonymously signed-in copy of the software may **read one document by key**
  — and keys are 60 bits, so they cannot be guessed.
- That copy may write back only `machineId`, `machineCode`, `activatedAt`,
  `lastSeenAt` and `appVersion`, and only while the licence is unclaimed or
  already belongs to that same machine. A second installation cannot overwrite
  somebody else's binding.
- Everything else in the project is closed to clients.

The customer's own data never leaves their computer. Firestore holds the licence
and nothing else: no guests, no bookings, no money.

---

## Plans

| Plan | Length | Units | Users |
|---|---|---|---|
| Trial | 30 days | 10 | 2 |
| Standard | 1 year | 25 | 5 |
| Professional | 1 year | 100 | 15 |
| Enterprise | 1 year | Unlimited | Unlimited |
| Lifetime | No expiry | Unlimited | Unlimited |

Choosing a plan fills in the expiry, the limits and the feature list; every one
of those can then be overridden per licence before you create it. Renewing
extends from the current expiry rather than from today, so a customer who
renews early is not robbed of the days they had left.

---

## Troubleshooting

**The panel shows "The panel could not start"** — the files in
`admin-panel/lib/` did not reach Firebase. Run `npm run deploy:panel` and
deploy again. (An earlier version sat on "Loading…" for ever in this case,
because a catch-all hosting rewrite turned the missing file into a 200 that
served HTML where JavaScript was expected. Both the rewrite and the missing
files are fixed.)

**Activation says Anonymous sign-in is switched off** — step 1 above. Enable
**Anonymous** under Authentication → Sign-in method. Nothing needs rebuilding or
reinstalling; the next Activate press works.

**"This account is not on the admins list"** — step 3 above. The document ID
must be the email address exactly, including case.

**"Activation needs an internet connection this one time"** — the customer's PC
cannot reach Firebase. A phone hotspot for thirty seconds is enough.

**"This licence is already in use on another computer"** — they have changed
PCs, or reinstalled Windows. Use **Release the computer**.

**"The stored licence does not belong to this computer"** — the licence cache
was copied from another machine, or Windows was reinstalled. Activate again;
release the binding in the panel first if it complains.
