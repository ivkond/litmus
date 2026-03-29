// web/src/lib/judge/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.JUDGE_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('JUDGE_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
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
