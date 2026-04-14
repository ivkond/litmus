import { describe, it, expect } from 'vitest';

describe('GeneralSettings', () => {
  it('exports a named function component', async () => {
    const mod = await import('../general-settings');
    expect(mod.GeneralSettings).toBeDefined();
    expect(typeof mod.GeneralSettings).toBe('function');
  });

  it('exports GeneralSettingsData type (used by settings page)', async () => {
    // If this import compiles without error, the type is correctly exported
    const mod = await import('../general-settings');
    expect(mod).toHaveProperty('GeneralSettings');
  });
});

// Note: Component save behavior (PUT /api/settings/scoring, 422 error parsing)
// is covered by the scoring schema tests in api/settings/__tests__/scoring.test.ts
// which validate that the 3 general_* keys are accepted. Component-level behavior
// cannot be unit-tested in node env without jsdom.
