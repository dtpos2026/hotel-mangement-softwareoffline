/**
 * Node-side licence cryptography, shared by the admin panel and the CLI.
 *
 * The private key never leaves the vendor's machine. Only the 32-byte public
 * key is embedded in the application.
 */

import { generateKeyPairSync, createPublicKey, createPrivateKey, sign, verify, createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// SPKI and PKCS8 prefixes for raw Ed25519 keys, so keys can be stored as plain
// 32-byte base64 rather than PEM blocks.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(12).toString('base64'),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(16).toString('base64')
  };
}

export function publicKeyFromBase64(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error('A public key must be 32 bytes.');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function privateKeyFromBase64(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error('A private key must be 32 bytes.');
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

export function signPayload(payload, privateKeyB64) {
  return new Uint8Array(sign(null, Buffer.from(payload), privateKeyFromBase64(privateKeyB64)));
}

export function verifyPayload(payload, signature, publicKeyB64) {
  try {
    return verify(null, Buffer.from(payload), publicKeyFromBase64(publicKeyB64), Buffer.from(signature));
  } catch { return false; }
}

/** First `bytes` of sha256 — used for the customer and machine fingerprints. */
export function shortHash(text, bytes) {
  return new Uint8Array(createHash('sha256').update(String(text || ''), 'utf8').digest().subarray(0, bytes));
}

/** Customer names are matched loosely so punctuation and case never matter. */
export function customerHash(name) {
  return shortHash(String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), 6);
}

export function machineHash(fingerprint) {
  return fingerprint ? shortHash(fingerprint, 4) : new Uint8Array(4);
}

/* ------------------------------------------------------------ vendor store */

export function loadStore(path) {
  if (!existsSync(path)) {
    return { keypair: null, nextLicenceNo: 1, customers: [], licences: [] };
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveStore(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf8');
}

export { randomUUID };
