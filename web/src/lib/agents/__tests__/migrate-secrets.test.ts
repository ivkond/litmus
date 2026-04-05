import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/lib/encryption', () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v.replace('enc:', '')),
  hasEncryptionKey: vi.fn(() => true),
}));

vi.mock('@/db/schema', () => ({
  agentSecrets: { agentExecutorId: 'agentExecutorId', authType: 'authType', acpMethodId: 'acpMethodId', encryptedValue: 'encryptedValue', id: 'id' },
}));

import { migrateSecretsToKeyedJson } from '../migrate-secrets';

describe('migrateSecretsToKeyedJson', () => {
  beforeEach(() => vi.clearAllMocks());

  it('test_migrateSecrets_plainStringFormat_convertsToKeyedJson', async () => {
    const { db } = await import('@/db');
    const mockRows = [
      { id: '1', acpMethodId: 'ANTHROPIC_API_KEY', encryptedValue: 'enc:sk-abc', authType: 'api_key' },
    ];
    const mockFrom = vi.fn().mockResolvedValue(mockRows);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: mockFrom });

    const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: mockSet });

    const count = await migrateSecretsToKeyedJson();
    expect(count).toBe(1);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ encryptedValue: 'enc:{"ANTHROPIC_API_KEY":"sk-abc"}' }),
    );
  });

  it('test_migrateSecrets_legacyOauthAuthType_renamedToCredentialFiles', async () => {
    const { db } = await import('@/db');
    const renamedRow = {
      id: 'legacy-1',
      acpMethodId: 'chatgpt',
      encryptedValue: 'enc:base64blobdata',
      authType: 'credential_files',
    };
    const mockFrom = vi.fn().mockResolvedValue([renamedRow]);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: mockFrom });
    const mockSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: mockSet });

    const count = await migrateSecretsToKeyedJson();
    expect(count).toBe(0);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('test_migrateSecrets_alreadyJsonFormat_skips', async () => {
    const { db } = await import('@/db');
    const mockRows = [
      { id: '2', acpMethodId: 'openai-api-key', encryptedValue: 'enc:{"OPENAI_API_KEY":"sk-xyz"}', authType: 'api_key' },
    ];
    const mockFrom = vi.fn().mockResolvedValue(mockRows);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: mockFrom });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) });

    const count = await migrateSecretsToKeyedJson();
    expect(count).toBe(0);
  });
});
