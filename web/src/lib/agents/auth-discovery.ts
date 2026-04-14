/**
 * ACP auth method as returned by the agent's initialize response.
 * Stored in agent_executors.authMethods (jsonb).
 */
export interface AcpAuthEnvVar {
  name: string;
  description?: string;
}

export interface AcpAuthMethod {
  id: string;
  type: 'env_var' | 'agent' | 'terminal';
  description?: string;
  vars?: AcpAuthEnvVar[];
  [key: string]: unknown;
}

const OAUTH_ID_PATTERNS = /oauth|chatgpt/i;
const OAUTH_DESC_PATTERNS = /oauth|device.?code|browser|sign.?in.?with/i;

/**
 * Extract and canonicalize auth methods from the ACP initialize response.
 * Per ACP SDK: `InitializeResponse.authMethods?: Array<AuthMethod>` (top-level).
 * - Entries without a `type` field are set to `type: 'agent'`.
 * - Unknown types are passed through as-is.
 */
export function extractAuthMethods(initResponse: Record<string, unknown>): AcpAuthMethod[] {
  const methods = initResponse.authMethods as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(methods)) return [];

  return methods.map((m) => {
    const method = { ...m } as AcpAuthMethod;
    // Canonicalize: set type='agent' when absent
    if (!method.type) {
      method.type = 'agent';
    }
    return method;
  });
}

/**
 * Heuristic: is this auth method likely an OAuth/device-code flow?
 * Only applies to `type === 'agent'` methods.
 */
export function isOAuthCapable(method: Pick<AcpAuthMethod, 'id' | 'type' | 'description'>): boolean {
  if (method.type !== 'agent') return false;

  if (OAUTH_ID_PATTERNS.test(method.id)) return true;

  if (method.description && OAUTH_DESC_PATTERNS.test(method.description)) return true;

  return false;
}