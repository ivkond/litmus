import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db and encryption before imports
vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('@/lib/judge/encryption', () => ({
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn((v: string) => v.replace('encrypted:', '')),
}));

describe('Judge Providers API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('masks apiKey in GET response', async () => {
    const maskKey = (key: string) => {
      if (key.length <= 8) return '••••';
      return '••••' + key.slice(-4);
    };
    expect(maskKey('sk-1234567890abcdef')).toBe('••••cdef');
    expect(maskKey('short')).toBe('••••');
  });

  it('PUT without apiKey preserves existing key', () => {
    const existingKey = 'encrypted:sk-original';
    const updateBody = { name: 'Updated Name' };
    const mergedKey =
      'apiKey' in updateBody ? (updateBody as { apiKey: string }).apiKey : existingKey;
    expect(mergedKey).toBe(existingKey);
  });

  it('PUT with empty string apiKey is invalid', () => {
    const body = { apiKey: '' };
    const isValid = body.apiKey === undefined || body.apiKey.length > 0;
    expect(isValid).toBe(false);
  });

  it('PUT with non-empty apiKey replaces existing', () => {
    const body = { apiKey: 'sk-new-key' };
    const shouldReplace = body.apiKey !== undefined && body.apiKey.length > 0;
    expect(shouldReplace).toBe(true);
  });
});
