#!/usr/bin/env node
/**
 * Licence command line — the scriptable half of the admin panel.
 *
 *   node tools/licence-cli.mjs keygen
 *   node tools/licence-cli.mjs issue --customer "Kalam Continental" --plan standard
 *   node tools/licence-cli.mjs inspect <KEY>
 *   node tools/licence-cli.mjs list
 *
 * The vendor store (including the private key) lives in vendor/ and is
 * git-ignored. Losing it means existing licences keep working but no new ones
 * can be signed for this public key — keep a backup.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  generateKeypair, signPayload, verifyPayload, customerHash, machineHash,
  loadStore, saveStore
} from './licence-crypto.mjs';
import {
  buildPayload, readPayload, encodeKey, splitKey, formatKey, describe, evaluate,
  planByKey, PLANS, PLAN_FEATURES, FEATURES, todayDay, dayToDate, dateToDay
} from '../src/core/license.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_PATH = join(ROOT, 'vendor', 'licences.json');
const PUBKEY_PATH = join(ROOT, 'src', 'core', 'license-key.js');

const args = process.argv.slice(2);
const command = args[0];

function flag(name, fallback) {
  const i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
function has(name) { return args.indexOf('--' + name) > -1; }

function writePublicKey(publicKey) {
  mkdirSync(dirname(PUBKEY_PATH), { recursive: true });
  writeFileSync(PUBKEY_PATH, `/**
 * Licence verification key — GENERATED, do not edit by hand.
 *
 * This is the public half of the vendor keypair. It can verify a licence but
 * cannot create one, so shipping it inside the installer is safe. Regenerate
 * with: npm run licence:keygen
 */

export const LICENCE_PUBLIC_KEY = '${publicKey}';
export const LICENCE_KEY_ISSUED = '${new Date().toISOString()}';
`, 'utf8');
}

switch (command) {
  case 'keygen': {
    const store = loadStore(STORE_PATH);
    if (store.keypair && !has('force')) {
      console.error('A keypair already exists. Re-running would invalidate every licence already issued.');
      console.error('Pass --force only if you are certain, and keep a backup of vendor/licences.json first.');
      process.exit(1);
    }
    const keypair = generateKeypair();
    store.keypair = keypair;
    store.createdAt = new Date().toISOString();
    saveStore(STORE_PATH, store);
    writePublicKey(keypair.publicKey);
    console.log('Keypair generated.');
    console.log('  private key  vendor/licences.json   (never share, never commit, back this up)');
    console.log('  public key   src/core/license-key.js (ships with the app)');
    break;
  }

  case 'issue': {
    const store = loadStore(STORE_PATH);
    if (!store.keypair) { console.error('No keypair yet. Run: npm run licence:keygen'); process.exit(1); }

    const customer = flag('customer');
    if (!customer) { console.error('--customer "Property name" is required.'); process.exit(1); }

    const planKey = flag('plan', 'standard');
    const plan = planByKey(planKey);
    if (plan.key !== planKey) { console.error(`Unknown plan "${planKey}". Options: ${PLANS.map(p => p.key).join(', ')}`); process.exit(1); }

    const days = Number(flag('days', plan.days));
    const expiryDay = days > 0 ? todayDay() + days : 0;
    const licenceNo = store.nextLicenceNo || 1;

    const payload = buildPayload({
      plan: plan.key,
      issuedDay: todayDay(),
      expiryDay,
      maxUnits: Number(flag('units', plan.maxUnits)),
      maxUsers: Number(flag('users', plan.maxUsers)),
      features: flag('features') ? flag('features').split(',') : PLAN_FEATURES[plan.key],
      licenceNo,
      customerHash: customerHash(customer),
      machineHash: machineHash(flag('machine'))
    });

    const signature = signPayload(payload, store.keypair.privateKey);
    const key = encodeKey(payload, signature);
    const info = describe(readPayload(payload));

    store.nextLicenceNo = licenceNo + 1;
    store.licences = store.licences || [];
    store.licences.push({
      licenceNo, customer, plan: plan.key, key,
      issuedAt: new Date().toISOString(),
      expiresAt: expiryDay ? dayToDate(expiryDay) : '',
      machine: flag('machine', ''), revoked: false
    });
    saveStore(STORE_PATH, store);

    console.log('');
    console.log(`  Licence #${info.licenceNo} for ${customer}`);
    console.log(`  Plan ${info.plan} · expires ${info.expires} · ${info.units} units · ${info.users} users`);
    console.log('');
    console.log(formatKey(key));
    console.log('');

    if (has('save')) {
      const file = join(ROOT, 'vendor', `licence-${String(licenceNo).padStart(5, '0')}.lic`);
      writeFileSync(file, formatKey(key) + '\n', 'utf8');
      console.log('  Saved to ' + file);
    }
    break;
  }

  case 'inspect': {
    const store = loadStore(STORE_PATH);
    const raw = args.slice(1).filter(a => !a.startsWith('--')).join('');
    if (!raw) { console.error('Pass the licence key to inspect.'); process.exit(1); }
    try {
      const { payload, signature } = splitKey(raw);
      const parsed = readPayload(payload);
      const info = describe(parsed);
      const signed = store.keypair ? verifyPayload(payload, signature, store.keypair.publicKey) : null;
      const check = evaluate(parsed, {});
      console.log('');
      console.log('  Licence #' + info.licenceNo);
      console.log('  Plan        ' + info.plan);
      console.log('  Issued      ' + info.issued);
      console.log('  Expires     ' + info.expires);
      console.log('  Units       ' + info.units);
      console.log('  Users       ' + info.users);
      console.log('  Machine     ' + (info.machineBound ? 'bound to one computer' : 'any computer'));
      console.log('  Signature   ' + (signed === null ? 'no keypair to check against' : signed ? 'valid' : 'INVALID'));
      console.log('  Status      ' + check.status + ' — ' + check.message);
      console.log('  Features    ' + info.features.join(', '));
      console.log('');
    } catch (err) { console.error('Could not read that key: ' + err.message); process.exit(1); }
    break;
  }

  case 'list': {
    const store = loadStore(STORE_PATH);
    const licences = store.licences || [];
    if (!licences.length) { console.log('No licences issued yet.'); break; }
    console.log('');
    console.log('  No     Customer                        Plan          Expires      Status');
    console.log('  ' + '-'.repeat(78));
    for (const l of licences) {
      console.log('  ' + String(l.licenceNo).padStart(5, '0') + '  ' +
        String(l.customer).slice(0, 30).padEnd(32) +
        String(l.plan).padEnd(14) +
        String(l.expiresAt || 'never').padEnd(13) +
        (l.revoked ? 'REVOKED' : 'active'));
    }
    console.log('');
    break;
  }

  default:
    console.log(`
  Licence tool

    npm run licence:keygen                     create the vendor keypair (once)
    node tools/licence-cli.mjs issue --customer "Name" [options]
    node tools/licence-cli.mjs inspect <KEY>
    node tools/licence-cli.mjs list

  Issue options
    --plan      ${PLANS.map(p => p.key).join(' | ')}
    --days      override the plan's duration (0 = never expires)
    --units     maximum units (0 = unlimited)
    --users     maximum users (0 = unlimited)
    --features  comma list: ${FEATURES.map(f => f.key).join(',')}
    --machine   bind to one computer's fingerprint
    --save      also write a .lic file
`);
}
