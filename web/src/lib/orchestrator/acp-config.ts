import type { AcpAgentConfig } from './types';

/**
 * Map agentType to ACP launch command + auth configuration.
 *
 * Agents with native ACP: opencode, kilocode.
 * Agents via ACP adapter: claude-code, codex, cursor.
 * Note: cline native --acp works but exits silently if stdin closes prematurely.
 *
 * Keys MUST match `agent_executors.agent_type` values in DB.
 *
 * credentialPaths are last-resort fallbacks (spec:363). They are directory paths
 * relative to /root, used when the agent's ACP authMethods[].credentialPaths
 * discovery extension is not present.
 */
export function resolveAcpConfig(agentType: string): AcpAgentConfig {
  const configs: Record<string, AcpAgentConfig> = {
    'claude-code': {
      acpCmd: ['claude-agent-acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/claude/'],
    },
    'codex': {
      acpCmd: ['codex-acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/codex/'],
    },
    'cursor': {
      acpCmd: ['cursor-agent-acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/cursor/'],
    },
    'cline': {
      acpCmd: ['cline', '--acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/cline/'],
    },
    'opencode': {
      acpCmd: ['opencode', 'acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.opencode/'],
    },
    'kilocode': {
      acpCmd: ['kilo', 'acp'],
      requiresAuth: true,
      capabilities: { auth: { terminal: true } },
      credentialPaths: ['.config/kilo/'],
    },
    'mock': {
      acpCmd: ['python3', '/opt/agent/mock-acp-server.py'],
      requiresAuth: false,
    },
  };

  const config = configs[agentType];
  if (!config) {
    throw new Error(
      `No ACP config for agent type "${agentType}". Known types: ${Object.keys(configs).join(', ')}`,
    );
  }
  return config;
}
