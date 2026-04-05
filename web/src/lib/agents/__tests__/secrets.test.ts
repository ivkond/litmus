import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  const deletedWhere: unknown[] = [];

  const whereChain = {
    where: vi.fn().mockImplementation(() => Promise.resolve(rows)),
  };
  const selectMock = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue(whereChain),
  });

  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn().mockReturnValue({
    onConflictDoUpdate: onConflictDoUpdateMock,
  });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn().mockReturnValue({
    where: deleteWhereMock,
  });

  const updateSetWhereMock = vi.fn().mockResolvedValue(undefined);
  const updateSetMock = vi.fn().mockReturnValue({ where: updateSetWhereMock });
  const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

  return {
    rows,
    selectMock,
    insertMock,
    valuesMock,
    onConflictDoUpdateMock,
    deleteMock,
    deleteWhereMock,
    updateMock,
    updateSetMock,
    updateSetWhereMock,
    deletedWhere,
  };
});

vi.mock('@/db', () => ({
  db: {
    select: dbMocks.selectMock,
    insert: dbMocks.insertMock,
    delete: dbMocks.deleteMock,
    update: dbMocks.updateMock,
  },
}));

vi.mock('@/db/schema', () => ({
  agentSecrets: {
    agentExecutorId: 'agent_executor_id',
    acpMethodId: 'acp_method_id',
    encryptedValue: 'encrypted_value',
    authType: 'auth_type',
    credentialPaths: 'credential_paths',
    updatedAt: 'updated_at',
  },
}));

vi.mock('@/lib/encryption', () => ({
  encrypt: vi.fn((plaintext: string) => `ENC:${plaintext}`),
  decrypt: vi.fn((ciphertext: string) => {
    if (ciphertext.startsWith('ENC:')) return ciphertext.slice(4);
    return ciphertext;
  }),
  hasEncryptionKey: vi.fn().mockReturnValue(true),
  maskKey: vi.fn((encrypted: string) => {
    const plain = encrypted.startsWith('ENC:') ? encrypted.slice(4) : encrypted;
    return plain.length > 8 ? '••••' + plain.slice(-4) : '••••';
  }),
}));

describe('getDecryptedSecretsForExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.rows.length = 0;
  });

  it('test_getDecryptedSecrets_newJsonFormat_unpacksToFlatRecord', async () => {
    dbMocks.rows.push({
      acpMethodId: 'cursor-api-key',
      encryptedValue: 'ENC:{"CURSOR_API_KEY":"sk-abc123"}',
      authType: 'api_key',
    });
    const { getDecryptedSecretsForExecutor } = await import('../secrets');
    const result = await getDecryptedSecretsForExecutor('executor-1');
    expect(result).toEqual({ CURSOR_API_KEY: 'sk-abc123' });
  });

  it('test_getDecryptedSecrets_multipleVarsPerMethod_allUnpacked', async () => {
    dbMocks.rows.push({
      acpMethodId: 'openai-keys',
      encryptedValue: 'ENC:{"OPENAI_API_KEY":"sk-1","OPENAI_ORG_ID":"org-2"}',
      authType: 'api_key',
    });
    const { getDecryptedSecretsForExecutor } = await import('../secrets');
    const result = await getDecryptedSecretsForExecutor('executor-1');
    expect(result).toEqual({ OPENAI_API_KEY: 'sk-1', OPENAI_ORG_ID: 'org-2' });
  });

  it('test_getDecryptedSecrets_credentialFiles_skipped', async () => {
    dbMocks.rows.push({
      acpMethodId: 'chatgpt-oauth',
      encryptedValue: 'ENC:base64blobdata',
      authType: 'credential_files',
    });
    const { getDecryptedSecretsForExecutor } = await import('../secrets');
    const result = await getDecryptedSecretsForExecutor('executor-1');
    expect(result).toEqual({});
  });

  it('test_getDecryptedSecrets_noEncryptionKey_returnsEmpty', async () => {
    const { hasEncryptionKey } = await import('@/lib/encryption');
    (hasEncryptionKey as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    const { getDecryptedSecretsForExecutor } = await import('../secrets');
    const result = await getDecryptedSecretsForExecutor('executor-1');
    expect(result).toEqual({});
  });
});

describe('saveSecret', () => {
  beforeEach(() => vi.clearAllMocks());

  it('test_saveSecret_apiKey_encryptsKeyedJson', async () => {
    const { saveSecret } = await import('../secrets');
    await saveSecret({
      executorId: 'e1',
      acpMethodId: 'cursor-api-key',
      values: { CURSOR_API_KEY: 'sk-test123' },
      authType: 'api_key',
    });
    expect(dbMocks.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentExecutorId: 'e1',
        acpMethodId: 'cursor-api-key',
        encryptedValue: 'ENC:{"CURSOR_API_KEY":"sk-test123"}',
        authType: 'api_key',
      }),
    );
    expect(dbMocks.onConflictDoUpdateMock).toHaveBeenCalled();
  });
});

describe('saveCredentialBlob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('test_saveCredentialBlob_encryptsBase64AndStoresPaths', async () => {
    const { saveCredentialBlob } = await import('../secrets');
    await saveCredentialBlob({
      executorId: 'e1',
      acpMethodId: 'chatgpt-oauth',
      base64Tar: 'dGVzdGRhdGE=',
      credentialPaths: ['.config/chatgpt/auth.json'],
    });
    expect(dbMocks.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentExecutorId: 'e1',
        acpMethodId: 'chatgpt-oauth',
        encryptedValue: 'ENC:dGVzdGRhdGE=',
        authType: 'credential_files',
        credentialPaths: ['.config/chatgpt/auth.json'],
      }),
    );
  });
});

describe('getCredentialBlobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.rows.length = 0;
  });

  it('test_getCredentialBlobs_returnsDecryptedBlobsForCredentialFiles', async () => {
    dbMocks.rows.push({
      acpMethodId: 'chatgpt-oauth',
      encryptedValue: 'ENC:dGVzdGRhdGE=',
      authType: 'credential_files',
      credentialPaths: ['.config/chatgpt/auth.json'],
    });
    const { getCredentialBlobs } = await import('../secrets');
    const result = await getCredentialBlobs('executor-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      acpMethodId: 'chatgpt-oauth',
      base64Tar: 'dGVzdGRhdGE=',
      credentialPaths: ['.config/chatgpt/auth.json'],
    });
  });

  it('test_getCredentialBlobs_filtersOutApiKeyType', async () => {
    dbMocks.rows.push({
      acpMethodId: 'cursor-api-key',
      encryptedValue: 'ENC:{"CURSOR_API_KEY":"sk-1"}',
      authType: 'api_key',
      credentialPaths: null,
    });
    const { getCredentialBlobs } = await import('../secrets');
    const result = await getCredentialBlobs('executor-1');
    expect(result).toHaveLength(0);
  });

  it('test_getCredentialBlobs_dbRowPaths_winOverFallbacks', async () => {
    dbMocks.rows.push({
      acpMethodId: 'chatgpt-oauth',
      encryptedValue: 'ENC:dGVzdA==',
      authType: 'credential_files',
      credentialPaths: ['.db/path/'],
    });
    const { getCredentialBlobs } = await import('../secrets');
    const result = await getCredentialBlobs('executor-1', { 'chatgpt-oauth': ['.discovery/path/'] }, ['.acp-config/path/']);
    expect(result[0].credentialPaths).toEqual(['.db/path/']);
  });

  it('test_getCredentialBlobs_discoveryPaths_usedWhenDbRowEmpty', async () => {
    dbMocks.rows.push({
      acpMethodId: 'chatgpt-oauth',
      encryptedValue: 'ENC:dGVzdA==',
      authType: 'credential_files',
      credentialPaths: [],
    });
    const { getCredentialBlobs } = await import('../secrets');
    const result = await getCredentialBlobs('executor-1', { 'chatgpt-oauth': ['.discovery/path/'] }, ['.acp-config/path/']);
    expect(result[0].credentialPaths).toEqual(['.discovery/path/']);
  });

  it('test_getCredentialBlobs_acpConfigPaths_usedAsLastResort', async () => {
    dbMocks.rows.push({
      acpMethodId: 'chatgpt-oauth',
      encryptedValue: 'ENC:dGVzdA==',
      authType: 'credential_files',
      credentialPaths: null,
    });
    const { getCredentialBlobs } = await import('../secrets');
    const result = await getCredentialBlobs('executor-1', {}, ['.acp-config/path/']);
    expect(result[0].credentialPaths).toEqual(['.acp-config/path/']);
  });
});
