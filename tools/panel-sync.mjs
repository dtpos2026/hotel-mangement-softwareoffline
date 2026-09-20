/**
 * Copies the files the admin panel shares with the desktop app into
 * admin-panel/lib/.
 *
 * The panel is deployed to Firebase Hosting from admin-panel/ alone, so it
 * cannot reach up into src/. Copying rather than duplicating keeps one source
 * of truth: if the licence model changes, the panel changes with it. The
 * copies are generated, never edited, and are not committed.
 *
 * Run by `npm run panel` and `npm run deploy:panel`, so it is not possible to
 * serve or deploy a stale copy.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SHARED = [
  ['src/core/licence-model.js', 'admin-panel/lib/licence-model.js'],
  ['src/ui/dom.js', 'admin-panel/lib/dom.js']
];

const banner = from =>
  `/* GENERATED FILE — do not edit.\n` +
  `   Copied from ${from} by tools/panel-sync.mjs.\n` +
  `   Edit the original and re-run \`npm run panel\`. */\n\n`;

mkdirSync(resolve(root, 'admin-panel/lib'), { recursive: true });

for (const [from, to] of SHARED) {
  const source = readFileSync(resolve(root, from), 'utf8');
  writeFileSync(resolve(root, to), banner(from) + source);
  console.log(`  ${from}  ->  ${to}`);
}

/* The Firebase project details live in one place — the file the desktop app
   reads — so the panel can never be pointed at a different project than the
   copies of the software it licenses. */
const require = createRequire(import.meta.url);
const firebaseConfig = require(resolve(root, 'electron/firebase-config.cjs'));

writeFileSync(
  resolve(root, 'admin-panel/lib/firebase-config.js'),
  banner('electron/firebase-config.cjs') +
  'export default ' + JSON.stringify(firebaseConfig, null, 2) + ';\n'
);
console.log('  electron/firebase-config.cjs  ->  admin-panel/lib/firebase-config.js');

console.log(`Synced ${SHARED.length + 1} shared file(s) into the admin panel.`);
