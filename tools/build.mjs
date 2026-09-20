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

/* --- the licence server must be configured ------------------------------ */

step('Licence server is configured', () => {
  const file = join(ROOT, 'electron', 'firebase-config.cjs');
  if (!existsSync(file)) {
    throw new Error('electron/firebase-config.cjs is missing, so no installed copy could verify a licence.');
  }
  const text = readFileSync(file, 'utf8');
  const apiKey = /apiKey:\s*'([^']+)'/.exec(text);
  const project = /projectId:\s*'([^']+)'/.exec(text);
  if (!apiKey || !apiKey[1] || apiKey[1].includes('YOUR_')) {
    throw new Error('No Firebase apiKey in electron/firebase-config.cjs.');
  }
  if (!project || !project[1] || project[1].includes('YOUR_')) {
    throw new Error('No Firebase projectId in electron/firebase-config.cjs.');
  }
  return project[1];
});

/* --- the admin panel must never reach a customer ------------------------ */

step('Admin panel is excluded from the installer', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const included = (pkg.build && pkg.build.files ? pkg.build.files : []).filter(f => !f.startsWith('!'));
  // A directory-scoped pattern such as "src/**/*" cannot reach admin-panel/;
  // only a top-level wildcard or a direct mention can.
  const risky = included.filter(f => /(^|\/)(admin-panel|tools|vendor)(\/|$)/.test(f) || /^\*/.test(f));
  if (risky.length) {
    throw new Error('These patterns in package.json "build.files" would ship the admin panel: ' + risky.join(', '));
  }
  return included.length + ' whitelisted paths';
});

/* --- the app itself has to be intact ------------------------------------ */

step('Application entry points exist', () => {
  const required = [
    'index.html', 'src/main.js', 'styles/app.css',
    'electron/main.cjs', 'electron/preload.cjs', 'electron/firebase-config.cjs',
    'electron/licence-service.cjs', 'src/core/licence-model.js',
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
    execSync('node tests/run.js && node tests/print.test.js && node tests/integration.test.js',
      { cwd: ROOT, stdio: 'pipe' });
    return 'domain, print, integration';
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
