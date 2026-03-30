import { describe, it, expect } from 'vitest';
import { settingsSchemas, settingsDefaults } from '@/lib/judge/types';

describe('Settings Zod validation', () => {
  it('validates composite_weights: sum must equal 1.0', () => {
    const schema = settingsSchemas['composite_weights'];
    expect(schema.safeParse({ test: 0.4, judge: 0.6 }).success).toBe(true);
    expect(schema.safeParse({ test: 0.5, judge: 0.6 }).success).toBe(false);
    expect(schema.safeParse({ test: 0, judge: 1 }).success).toBe(false); // 0 not positive
  });

  it('validates criteria_priority: exactly 10 items', () => {
    const schema = settingsSchemas['criteria_priority'];
    const criteriaDef = settingsDefaults['criteria_priority'] as { order: string[]; preset: string };
    const valid = { order: criteriaDef.order, preset: 'linear' };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, order: ['only_one'] }).success).toBe(false);
    expect(schema.safeParse({ ...valid, preset: 'unknown' }).success).toBe(false);
  });

  it('validates judge_temperature: range 0-1', () => {
    const schema = settingsSchemas['judge_temperature'];
    expect(schema.safeParse(0.3).success).toBe(true);
    expect(schema.safeParse(1.5).success).toBe(false);
    expect(schema.safeParse(-0.1).success).toBe(false);
  });

  it('validates judge_task_idle_timeout_ms: range 60000-1800000', () => {
    const schema = settingsSchemas['judge_task_idle_timeout_ms'];
    expect(schema.safeParse(300000).success).toBe(true);
    expect(schema.safeParse(1000).success).toBe(false);
    expect(schema.safeParse(2000000).success).toBe(false);
  });

  it('has general settings keys registered', () => {
    expect(settingsSchemas).toHaveProperty('general_theme');
    expect(settingsSchemas).toHaveProperty('general_auto_judge');
    expect(settingsSchemas).toHaveProperty('general_max_concurrent_lanes');
  });

  it('general_theme accepts light/dark/system only', () => {
    const schema = settingsSchemas['general_theme'];
    expect(schema.safeParse('dark').success).toBe(true);
    expect(schema.safeParse('light').success).toBe(true);
    expect(schema.safeParse('system').success).toBe(true);
    expect(schema.safeParse('auto').success).toBe(false);
  });

  it('general_max_concurrent_lanes: range 1-10', () => {
    const schema = settingsSchemas['general_max_concurrent_lanes'];
    expect(schema.safeParse(3).success).toBe(true);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(11).success).toBe(false);
  });

  it('all defaults pass their own validation', () => {
    for (const [key, schema] of Object.entries(settingsSchemas)) {
      const defaultValue = settingsDefaults[key];
      const result = schema.safeParse(defaultValue);
      expect(result.success, `Default for ${key} should be valid`).toBe(true);
    }
  });
});
