import { describe, it, expect } from 'vitest';
import type { InferSelectModel } from 'drizzle-orm';
import { agentExecutors, agentSecrets } from '../schema';

describe('ACP auth schema types', () => {
  it('test_agentExecutors_hasAuthMethodsField_jsonbNullable', () => {
    type Executor = InferSelectModel<typeof agentExecutors>;
    const check: Executor['authMethods'] = null;
    expect(check).toBeNull();
  });

  it('test_agentExecutors_hasAuthMethodsDiscoveredAt_timestampNullable', () => {
    type Executor = InferSelectModel<typeof agentExecutors>;
    const check: Executor['authMethodsDiscoveredAt'] = null;
    expect(check).toBeNull();
  });

  it('test_agentSecrets_hasAcpMethodId_textNotNull', () => {
    type Secret = InferSelectModel<typeof agentSecrets>;
    const check: Secret['acpMethodId'] = 'some-method-id';
    expect(check).toBe('some-method-id');
  });

  it('test_agentSecrets_hasCredentialPaths_jsonbNullable', () => {
    type Secret = InferSelectModel<typeof agentSecrets>;
    const check: Secret['credentialPaths'] = null;
    expect(check).toBeNull();
  });

  it('test_agentSecrets_authType_includesCredentialFiles', () => {
    type Secret = InferSelectModel<typeof agentSecrets>;
    const check: Secret['authType'] = 'credential_files';
    expect(check).toBe('credential_files');
  });

  it('test_agentSecrets_noEnvVarField', () => {
    type Secret = InferSelectModel<typeof agentSecrets>;
    // @ts-expect-error envVar should not exist on the type
    const _check: Secret['envVar'] = 'should-not-compile';
    expect(true).toBe(true);
  });
});
