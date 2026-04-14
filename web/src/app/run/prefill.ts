const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PrefillParams {
  agents: string | null;
  models: string | null;
  scenarios: string | null;
}

interface PrefillResult {
  agentIds: string[];
  modelIds: string[];
  scenarioIds: string[];
}

function parseUuidList(value: string | null): string[] {
  if (!value) return [];
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
  return [...new Set(ids)];
}

export function parsePrefillParams(params: PrefillParams): PrefillResult {
  return {
    agentIds: parseUuidList(params.agents),
    modelIds: parseUuidList(params.models),
    scenarioIds: parseUuidList(params.scenarios),
  };
}
