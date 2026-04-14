import { describe, it, expect } from 'vitest';
import { extractAuthMethods, isOAuthCapable } from '../auth-discovery';

describe('extractAuthMethods', () => {
  it('test_extractAuthMethods_envVarType_passedThrough', () => {
    const initResponse = {
      authMethods: [
        { id: 'openai-key', type: 'env_var', description: 'OpenAI API Key', vars: [{ name: 'OPENAI_API_KEY' }] },
      ],
    };

    const result = extractAuthMethods(initResponse);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'openai-key',
      type: 'env_var',
      description: 'OpenAI API Key',
      vars: [{ name: 'OPENAI_API_KEY' }],
    });
  });

  it('test_extractAuthMethods_noType_canonicalizesToAgent', () => {
    const initResponse = {
      authMethods: [
        { id: 'chatgpt', description: 'ChatGPT login' },
      ],
    };

    const result = extractAuthMethods(initResponse);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('agent');
  });

  it('test_extractAuthMethods_agentType_preserved', () => {
    const initResponse = {
      authMethods: [
        { id: 'github-oauth', type: 'agent', description: 'GitHub OAuth' },
      ],
    };

    const result = extractAuthMethods(initResponse);
    expect(result[0].type).toBe('agent');
  });

  it('test_extractAuthMethods_noAuthMethods_returnsEmptyArray', () => {
    const initResponse = { capabilities: {} };
    expect(extractAuthMethods(initResponse)).toEqual([]);
  });

  it('test_extractAuthMethods_emptyResponse_returnsEmptyArray', () => {
    const initResponse = {};
    expect(extractAuthMethods(initResponse)).toEqual([]);
  });

  it('test_extractAuthMethods_multipleMethodTypes_allCanonicalized', () => {
    const initResponse = {
      authMethods: [
        { id: 'api-key', type: 'env_var', description: 'API Key', vars: [{ name: 'API_KEY' }] },
        { id: 'chatgpt', description: 'ChatGPT' },
        { id: 'github', type: 'agent', description: 'GitHub' },
        { id: 'terminal-login', type: 'terminal', description: 'Terminal Login' },
      ],
    };

    const result = extractAuthMethods(initResponse);
    expect(result).toHaveLength(4);
    expect(result.map((m) => m.type)).toEqual(['env_var', 'agent', 'agent', 'terminal']);
  });
});

describe('isOAuthCapable', () => {
  it('test_isOAuthCapable_idContainsOauth_true', () => {
    expect(isOAuthCapable({ id: 'github-oauth', type: 'agent', description: 'GitHub' })).toBe(true);
  });

  it('test_isOAuthCapable_idIsChatgpt_true', () => {
    expect(isOAuthCapable({ id: 'chatgpt', type: 'agent', description: 'ChatGPT login' })).toBe(true);
  });

  it('test_isOAuthCapable_descriptionContainsOAuth_true', () => {
    expect(isOAuthCapable({ id: 'login', type: 'agent', description: 'OAuth Login' })).toBe(true);
  });

  it('test_isOAuthCapable_envVarType_false', () => {
    expect(isOAuthCapable({ id: 'api-key', type: 'env_var', description: 'API Key' })).toBe(false);
  });

  it('test_isOAuthCapable_terminalType_false', () => {
    expect(isOAuthCapable({ id: 'terminal', type: 'terminal', description: 'Terminal' })).toBe(false);
  });

  it('test_isOAuthCapable_noIdOrDescription_returnsFalse', () => {
    expect(isOAuthCapable({ type: 'agent' } as any)).toBe(false);
  });
});