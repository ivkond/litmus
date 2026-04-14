import { describe, it, expect } from 'vitest';

// Test the pure parsing logic that will be extracted into a helper
describe('parsePrefillParams', () => {
  it('exports parsePrefillParams function', async () => {
    const mod = await import('../prefill');
    expect(mod.parsePrefillParams).toBeDefined();
    expect(typeof mod.parsePrefillParams).toBe('function');
  });

  it('parses comma-separated UUIDs from params', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const result = parsePrefillParams({
      agents: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890,a1b2c3d4-e5f6-7890-abcd-ef1234567891',
      models: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
      scenarios: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890,c1b2c3d4-e5f6-7890-abcd-ef1234567891,c1b2c3d4-e5f6-7890-abcd-ef1234567892',
    });
    expect(result.agentIds).toEqual([
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567891',
    ]);
    expect(result.modelIds).toEqual(['b1b2c3d4-e5f6-7890-abcd-ef1234567890']);
    expect(result.scenarioIds).toHaveLength(3);
  });

  it('returns empty arrays when params are null/undefined', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const result = parsePrefillParams({
      agents: null,
      models: null,
      scenarios: null,
    });
    expect(result).toEqual({ agentIds: [], modelIds: [], scenarioIds: [] });
  });

  it('filters out non-UUID strings', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const result = parsePrefillParams({
      agents: 'not-a-uuid,a1b2c3d4-e5f6-7890-abcd-ef1234567890,also-invalid',
      models: '',
      scenarios: null,
    });
    expect(result.agentIds).toEqual(['a1b2c3d4-e5f6-7890-abcd-ef1234567890']);
    expect(result.modelIds).toEqual([]);
    expect(result.scenarioIds).toEqual([]);
  });

  it('handles empty string params', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const result = parsePrefillParams({
      agents: '',
      models: '',
      scenarios: '',
    });
    expect(result).toEqual({ agentIds: [], modelIds: [], scenarioIds: [] });
  });

  it('deduplicates IDs', async () => {
    const { parsePrefillParams } = await import('../prefill');
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = parsePrefillParams({
      agents: `${uuid},${uuid},${uuid}`,
      models: null,
      scenarios: null,
    });
    expect(result.agentIds).toEqual([uuid]);
  });
});
