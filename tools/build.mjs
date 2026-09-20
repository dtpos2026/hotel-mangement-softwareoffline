#!/usr/bin/env node
/**
 * Pre-flight for `npm run dist`.
 *
 * The two mistakes that would be expensive to discover after an installer has
 * been sent to a customer are: shipping without a verification key (so every
 * copy runs trial-only and no licence can ever be activated), and shipping the
 * private key (so anyone can mint their own licences). Both are checked here,
 * and either one stops the build.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const red = s => `\x1b[31m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;

let failed = false;
const step = (label, fn) => {
  try {
    const note = fn();
    console.log(`  ${green('✓')} ${label}${note ? dim('  ' + note) : ''}`);
  } catch (err) {
    failed = true;
    console.log(`  ${red('✗')} ${label}`);
    console.log(`    ${red(err.message)}`);
  }
};

console.log('\nPreparing the build\n');

/* --- the verification key must be present and real ---------------------- */

step('Licence verification key is built in', () => {
  const keyFile = join(ROOT, 'src', 'core', 'license-key.js');
  if (!existsSync(keyFile)) {
    throw new Error(
      'src/core/license-key.js is missing, so the installer could not verify any licence.\n' +
      '    Run this once, then build again:  npm run licence:keygen');
  }
  const text = readFileSync(keyFile, 'utf8');
  const m = /LICENCE_PUBLIC_KEY\s*=\s*'([^']+)'/.exec(text);
  if (!m) throw new Error('license-key.js does not contain a key. Re-run: npm run licence:keygen');
  const raw = Buffer.from(m[1], 'base64');
  if (raw.length !== 32) throw new Error(`The public key should be 32 bytes and this one is ${raw.length}.`);
  return m[1].slice(0, 12) + '…';
});

/* --- the private key must NOT be anywhere the packager will look -------- */

step('Private signing key is excluded from the package', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build && pkg.build.files ? pkg.build.files : [];
  const included = files.filter(f => !f.startsWith('!'));
  // A pattern is only dangerous if it names vendor/tools directly, or if it is
  // rooted at the project top with a wildcard. A directory-scoped pattern such
  // as "src/**/*" cannot reach vendor/.
  const risky = included.filter(f => /(^|\/)(vendor|tools)(\/|$)/.test(f) || /^\*/.test(f));
  if (risky.length) {
    throw new Error(
      'These patterns in package.json "build.files" could sweep in vendor/ (which holds the\n' +
      '    private signing key): ' + risky.join(', '));
  }
  if (existsSync(join(ROOT, 'vendor'))) {
    const gitignore = existsSync(join(ROOT, '.gitignore')) ? readFileSync(join(ROOT, '.gitignore'), 'utf8') : '';
    if (!/^vendor\/?$/m.test(gitignore)) {
      throw new Error('vendor/ exists but is not in .gitignore — the private key could be committed.');
    }
  }
  return included.length + ' whitelisted paths';
});

/* --- the app itself has to be intact ------------------------------------ */

step('Application entry points exist', () => {
  const required = [
    'index.html', 'src/main.js', 'styles/app.css',
    'electron/main.cjs', 'electron/preload.cjs',
    'assets/brand-digital-target.jpg', 'build/icon.png'
  ];
  const missing = required.filter(f => !existsSync(join(ROOT, f)));
  if (missing.length) throw new Error('Missing: ' + missing.join(', '));
  return required.length + ' files';
});

step('No stray CDN dependency in the shipped page', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const blocking = html.match(/<script[^>]+src=["']https?:/gi);
  if (blocking) throw new Error('index.html loads a script over the network: ' + blocking.join(', '));
  return 'fonts link is non-blocking';
});

/* --- tests ---------------------------------------------------------------- */

if (process.argv.includes('--skip-tests')) {
  console.log(`  ${dim('•')} ${dim('Tests skipped (--skip-tests)')}`);
} else {
  step('Test suite passes', () => {
    execSync('node tests/run.js && node tests/print.test.js && node tests/licence.test.js && node tests/integration.test.js',
      { cwd: ROOT, stdio: 'pipe' });
    return 'domain, print, licence, integration';
  });
}

/* --- build stamp ---------------------------------------------------------- */

step('Build stamp written', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  let commit = '';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: 'pipe' }).toString().trim(); } catch { /* not a repo */ }
  mkdirSync(join(ROOT, 'src', 'core'), { recursive: true });
  writeFileSync(join(ROOT, 'src', 'core', 'build-info.js'),
`/** GENERATED at build time — do not edit. */
export const BUILD = {
  version: '${pkg.version}',
  builtAt: '${new Date().toISOString()}',
  commit: '${commit}'
};
`, 'utf8');
  return pkg.version + (commit ? ' · ' + commit : '');
});

console.log('');
if (failed) {
  console.log(red('Build stopped. Fix the items above and run it again.\n'));
  process.exit(1);
}
console.log(green('Ready to package.') + dim('  Next: electron-builder runs automatically.\n'));
