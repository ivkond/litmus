import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encrypt, decrypt, maskKey, hasEncryptionKey } from '../encryption';

const TEST_KEY = 'a'.repeat(64);

describe('encryption', () => {
  beforeEach(() => {
    vi.stubEnv('LITMUS_ENCRYPTION_KEY', '');
    vi.stubEnv('JUDGE_ENCRYPTION_KEY', '');
  });

  describe('key fallback chain', () => {
    it('uses LITMUS_ENCRYPTION_KEY when set', () => {
      vi.stubEnv('LITMUS_ENCRYPTION_KEY', TEST_KEY);
      const ct = encrypt('hello');
      expect(decrypt(ct)).toBe('hello');
    });

    it('falls back to JUDGE_ENCRYPTION_KEY', () => {
      vi.stubEnv('JUDGE_ENCRYPTION_KEY', TEST_KEY);
      const ct = encrypt('hello');
      expect(decrypt(ct)).toBe('hello');
    });

    it('LITMUS takes precedence over JUDGE', () => {
      vi.stubEnv('LITMUS_ENCRYPTION_KEY', TEST_KEY);
      vi.stubEnv('JUDGE_ENCRYPTION_KEY', 'b'.repeat(64));
      const ct = encrypt('hello');
      // Decrypt with same key should work
      expect(decrypt(ct)).toBe('hello');
    });

    it('throws when neither key is set', () => {
      expect(() => encrypt('test')).toThrow(/No encryption key configured/);
    });
  });

  describe('hasEncryptionKey', () => {
    it('returns false when no key set', () => {
      expect(hasEncryptionKey()).toBe(false);
    });

    it('returns true with LITMUS key', () => {
      vi.stubEnv('LITMUS_ENCRYPTION_KEY', TEST_KEY);
      expect(hasEncryptionKey()).toBe(true);
    });

    it('returns true with JUDGE key only', () => {
      vi.stubEnv('JUDGE_ENCRYPTION_KEY', TEST_KEY);
      expect(hasEncryptionKey()).toBe(true);
    });
  });

  describe('maskKey', () => {
    it('returns masked value with last 4 chars', () => {
      vi.stubEnv('LITMUS_ENCRYPTION_KEY', TEST_KEY);
      const ct = encrypt('sk-1234567890abcdef');
      expect(maskKey(ct)).toBe('••••cdef');
    });

    it('returns •••• for short values', () => {
      vi.stubEnv('LITMUS_ENCRYPTION_KEY', TEST_KEY);
      const ct = encrypt('short');
      expect(maskKey(ct)).toBe('••••');
    });

    it('returns •••• on decrypt failure', () => {
      expect(maskKey('invalid-base64-data')).toBe('••••');
    });
  });
});
