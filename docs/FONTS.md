# Pinning the fonts completely offline

The application never requires a network request. `index.html` links Google
Fonts as an enhancement only — offline the link fails silently and the fallback
stacks in `styles/app.css` take over:

| Role | Stack |
|------|-------|
| Interface | Plus Jakarta Sans → Segoe UI → system sans |
| Figures, dates, serials | IBM Plex Mono → Consolas → Courier New |
| Urdu | Noto Nastaliq Urdu → **Jameel Noori Nastaleeq** → Urdu Typesetting → Nafees Nastaleeq → serif |

On a typical Pakistani Windows machine this already gives proper Nastaliq
shaping, because Jameel Noori Nastaleeq is usually installed and Urdu
Typesetting ships with Windows.

## Bundling the exact typefaces

To make the rendering identical on every machine, drop the `.woff2` files into
`assets/fonts/` and add this to the top of `styles/app.css`:

```css
@font-face {
  font-family: 'Plus Jakarta Sans';
  src: local('Plus Jakarta Sans'), url('../assets/fonts/PlusJakartaSans.woff2') format('woff2');
  font-weight: 400 700;
  font-display: swap;
}
@font-face {
  font-family: 'IBM Plex Mono';
  src: local('IBM Plex Mono'), url('../assets/fonts/IBMPlexMono.woff2') format('woff2');
  font-weight: 400 700;
  font-display: swap;
}
@font-face {
  font-family: 'Noto Nastaliq Urdu';
  src: local('Noto Nastaliq Urdu'), url('../assets/fonts/NotoNastaliqUrdu.woff2') format('woff2');
  font-weight: 400 600;
  font-display: swap;
}
```

`local()` comes first so an installed copy is used without touching disk.

Then remove the `<link rel="stylesheet" ... fonts.googleapis.com ...>` line
from `index.html`, and the app makes no outbound request at all.

Sources (download once, on a machine with internet):

- Plus Jakarta Sans — https://fonts.google.com/specimen/Plus+Jakarta+Sans
- IBM Plex Mono — https://fonts.google.com/specimen/IBM+Plex+Mono
- Noto Nastaliq Urdu — https://fonts.google.com/noto/specimen/Noto+Nastaliq+Urdu

Noto Nastaliq Urdu is around 500KB; the other two are about 40KB each as
variable woff2.

## Printing

The 80mm and A4 renderers deliberately do **not** use the web fonts. They use
system stacks (`Segoe UI`/`Helvetica`/Arial for text, `Consolas`/`Menlo` for
figures), because a print job must never wait on a font that may not load, and
thermal output is crisper in a font the machine already has.
