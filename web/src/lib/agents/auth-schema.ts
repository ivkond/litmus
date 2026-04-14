import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ApiKeyAuthMethod {
  type: 'api_key';
  envVar: string;
  label: string;
  required: boolean;
  helpUrl?: string;
}

export interface OAuthAuthMethod {
  type: 'oauth';
  envVar: string;
  label: string;
  required: boolean;
  provider: string;
  scopes: string[];
}

export type AuthMethod = ApiKeyAuthMethod | OAuthAuthMethod;

export interface AgentAuthSchema {
  authMethods: AuthMethod[];
}

const EMPTY_SCHEMA: AgentAuthSchema = { authMethods: [] };

function resolveAuthJsonPath(agentType: string): string {
  if (process.env.LITMUS_IN_DOCKER === '1') {
    return path.join('/opt/agent', agentType, 'auth.json');
  }
  return path.resolve(process.cwd(), 'agents', agentType, 'auth.json');
}

/** Load the auth schema for an agent type (vendor directory). Returns empty schema if auth.json missing. */
export async function loadAuthSchema(agentType: string): Promise<AgentAuthSchema> {
  try {
    const content = await readFile(resolveAuthJsonPath(agentType), 'utf-8');
    return JSON.parse(content) as AgentAuthSchema;
  } catch {
    return EMPTY_SCHEMA;
  }
}
