/**
 * crypto-utils.js — AES-256-GCM encryption for wallet seeds at rest.
 *
 * Encrypted format: hex(iv):hex(authTag):hex(ciphertext)
 * Key: 32-byte hex from ENCRYPTION_KEY env var.
 *
 * If ENCRYPTION_KEY is not set, encrypt/decrypt are no-ops (dev mode).
 * Plaintext seeds are detected and re-encrypted on first read.
 */

const crypto = require('crypto');

const KEY_HEX = process.env.ENCRYPTION_KEY || '';
const ALGO    = 'aes-256-gcm';

function keyBuffer() {
  if (!KEY_HEX || KEY_HEX.length < 64) return null;
  return Buffer.from(KEY_HEX, 'hex');
}

/** Returns true if value looks like an encrypted seed (contains two colons) */
function isEncrypted(value) {
  return typeof value === 'string' && value.split(':').length === 3;
}

/** Encrypt a plaintext seed. Returns encrypted string or plaintext if no key. */
function encryptSeed(plaintext) {
  const key = keyBuffer();
  if (!key) return plaintext; // dev mode — no key set

  const iv       = crypto.randomBytes(12);
  const cipher   = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag  = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Decrypt an encrypted seed. Returns plaintext, or the original value if already plaintext. */
function decryptSeed(value) {
  if (!value) return value;
  if (!isEncrypted(value)) return value; // already plaintext (old record)

  const key = keyBuffer();
  if (!key) return value; // no key — can't decrypt, return as-is

  try {
    const [ivHex, authTagHex, dataHex] = value.split(':');
    const iv       = Buffer.from(ivHex, 'hex');
    const authTag  = Buffer.from(authTagHex, 'hex');
    const data     = Buffer.from(dataHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
  } catch (err) {
    console.error('[crypto] Decryption failed:', err.message);
    return null; // corrupted or wrong key
  }
}

module.exports = { encryptSeed, decryptSeed, isEncrypted };
