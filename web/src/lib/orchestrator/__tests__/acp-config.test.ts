import { describe, it, expect } from 'vitest';
import { resolveAcpConfig } from '../acp-config';

describe('resolveAcpConfig', () => {
  it('test_resolveAcpConfig_knownType_returnsConfig', () => {
    const config = resolveAcpConfig('claude-code');
    expect(config.acpCmd).toEqual(['claude-agent-acp']);
    expect(config.requiresAuth).toBe(true);
  });

  it('test_resolveAcpConfig_mock_requiresAuthFalse', () => {
    const config = resolveAcpConfig('mock');
    expect(config.requiresAuth).toBe(false);
    expect(config.acpCmd).toEqual(['python3', '/opt/agent/mock-acp-server.py']);
  });

  it('test_resolveAcpConfig_unknownType_throws', () => {
    expect(() => resolveAcpConfig('nonexistent')).toThrow('No ACP config for agent type');
  });

  it('test_resolveAcpConfig_allTypes_haveCapabilitiesWithAuthTerminal', () => {
    const types = ['claude-code', 'codex', 'cursor', 'cline', 'opencode', 'kilocode'];
    for (const type of types) {
      const config = resolveAcpConfig(type);
      expect(config.capabilities).toBeDefined();
      expect(config.capabilities?.auth).toEqual({ terminal: true });
    }
  });

  it('test_resolveAcpConfig_cursor_hasCredentialPaths', () => {
    const config = resolveAcpConfig('cursor');
    expect(config.credentialPaths).toBeDefined();
    expect(Array.isArray(config.credentialPaths)).toBe(true);
  });

  it('test_resolveAcpConfig_mock_noCredentialPaths', () => {
    const config = resolveAcpConfig('mock');
    expect(config.credentialPaths).toBeUndefined();
  });
});
