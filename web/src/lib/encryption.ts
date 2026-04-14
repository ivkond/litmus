import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.LITMUS_ENCRYPTION_KEY || process.env.JUDGE_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'No encryption key configured (set LITMUS_ENCRYPTION_KEY or JUDGE_ENCRYPTION_KEY)',
    );
  }
  return Buffer.from(hex, 'hex');
}

/** Returns true if at least one encryption key env var is set and valid. */
export function hasEncryptionKey(): boolean {
  const hex = process.env.LITMUS_ENCRYPTION_KEY || process.env.JUDGE_ENCRYPTION_KEY;
  return !!hex && hex.length === 64;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString('base64');
}

export function decrypt(ciphertextBase64: string): string {
  const key = getKey();
  const data = Buffer.from(ciphertextBase64, 'base64');
  const nonce = data.subarray(0, NONCE_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const encrypted = data.subarray(NONCE_LENGTH, data.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/** Decrypt an encrypted value and return a masked version for display: `••••last4`. */
export function maskKey(encryptedKey: string): string {
  try {
    const plain = decrypt(encryptedKey);
    if (plain.length <= 8) return '••••';
    return '••••' + plain.slice(-4);
  } catch {
    return '••••';
  }
}
