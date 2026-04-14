// web/src/lib/judge/__tests__/encryption.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encrypt, decrypt } from '../encryption';

describe('encryption', () => {
  beforeEach(() => {
    vi.stubEnv('JUDGE_ENCRYPTION_KEY', 'a'.repeat(64));
  });

  it('roundtrip: encrypt then decrypt returns original', () => {
    const plaintext = 'sk-test-key-12345';
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertext for same input (random nonce)', () => {
    const plaintext = 'sk-test-key-12345';
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    expect(c1).not.toBe(c2);
  });

  it('ciphertext is base64-encoded', () => {
    const ciphertext = encrypt('test');
    expect(() => Buffer.from(ciphertext, 'base64')).not.toThrow();
  });

  it('throws on missing JUDGE_ENCRYPTION_KEY', () => {
    vi.stubEnv('JUDGE_ENCRYPTION_KEY', '');
    expect(() => encrypt('test')).toThrow();
  });

  it('throws on tampered ciphertext', () => {
    const ciphertext = encrypt('test');
    const tampered = ciphertext.slice(0, -4) + 'AAAA';
    expect(() => decrypt(tampered)).toThrow();
  });
});
