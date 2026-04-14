'use client';

import { useState, useEffect, useCallback } from 'react';

interface ScoringSettings {
  composite_weights: { test: number; judge: number };
  criteria_priority: { order: string[]; preset: string };
  blocking_caps: Record<string, number>;
  judge_max_retries: number;
  judge_max_concurrent_per_provider: number;
  judge_max_concurrent_global: number;
  judge_temperature: number;
  log_compression: string;
  max_compressed_chars: number;
  max_judge_prompt_chars: number;
  judge_task_idle_timeout_ms: number;
  judge_raw_response_retention_days: number;
  [key: string]: unknown;
}

const CRITERIA_LABELS: Record<string, string> = {
  task_success: 'Task success',
  solution_correctness: 'Solution correctness',
  instruction_following: 'Instruction following',
  design_quality: 'Design quality',
  tool_action_quality: 'Tool/action quality',
  reasoning_diagnosis: 'Reasoning/diagnosis',
  recovery_adaptivity: 'Recovery/adaptivity',
  safety_scope_control: 'Safety/scope control',
  context_state_handling: 'Context/state handling',
  verification_awareness: 'Verification awareness',
};

/** Compute weights client-side (mirrors criteria.ts logic) */
function computeWeights(order: string[], preset: string): Record<string, number> {
  const N = order.length;
  const rawWeights: number[] = [];
  for (let i = 0; i < N; i++) {
    const rank = i + 1;
    switch (preset) {
      case 'flat':
        rawWeights.push(1);
        break;
      case 'linear':
        rawWeights.push(N - rank + 1);
        break;
      case 'steep':
        rawWeights.push((N - rank + 1) ** 2);
        break;
      default:
        rawWeights.push(1);
    }
  }
  const sum = rawWeights.reduce((a, b) => a + b, 0);
  const result: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    result[order[i]] = rawWeights[i] / sum;
  }
  return result;
}

const inputClass =
  'w-24 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]';
const readOnlyClass =
  'w-24 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1 text-sm text-[var(--text-secondary)]';
const labelClass = 'text-sm text-[var(--text-secondary)]';
const sectionTitleClass = 'font-medium text-[var(--text-primary)] mb-2';

export function ScoringConfig() {
  const [settings, setSettings] = useState<ScoringSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/scoring')
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: ScoringSettings) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveSettings = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    const res = await fetch('/api/settings/scoring', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    if (res.ok) {
      setSettings(await res.json());
    }
    setSaving(false);
  }, [settings]);

  const resetToDefaults = useCallback(async () => {
    setSaving(true);
    const res = await fetch('/api/settings/scoring', { method: 'DELETE' });
    if (res.ok) {
      setSettings(await res.json());
    }
    setSaving(false);
  }, []);

  if (!settings) {
    return <div className="text-[var(--text-secondary)]">Loading scoring config…</div>;
  }

  const weights = computeWeights(
    settings.criteria_priority.order,
    settings.criteria_priority.preset
  );
  const maxWeight = Math.max(...Object.values(weights));

  function updateSetting<K extends keyof ScoringSettings>(key: K, value: ScoringSettings[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleDragStart(index: number) {
    setDragIdx(index);
  }

  function handleDragOver(e: React.DragEvent, targetIdx: number) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === targetIdx || !settings) return;
    const newOrder = [...settings.criteria_priority.order];
    const [moved] = newOrder.splice(dragIdx, 1);
    newOrder.splice(targetIdx, 0, moved);
    updateSetting('criteria_priority', { ...settings.criteria_priority, order: newOrder });
    setDragIdx(targetIdx);
  }

  function handleDragEnd() {
    setDragIdx(null);
  }

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">Scoring Configuration</h2>

      {/* Composite Weights */}
      <div>
        <h3 className={sectionTitleClass}>Composite Weights</h3>
        <div className="flex items-center gap-4">
          <label className={`flex items-center gap-2 ${labelClass}`}>
            Test:
            <input
              type="number"
              step="0.05"
              min="0.05"
              max="0.95"
              className={inputClass}
              value={settings.composite_weights.test}
              onChange={(e) => {
                const test = parseFloat(e.target.value);
                if (!isNaN(test) && test > 0 && test < 1) {
                  updateSetting('composite_weights', { test, judge: +(1 - test).toFixed(2) });
                }
              }}
            />
          </label>
          <label className={`flex items-center gap-2 ${labelClass}`}>
            Judge:
            <input
              type="number"
              className={readOnlyClass}
              value={settings.composite_weights.judge}
              readOnly
            />
          </label>
        </div>
      </div>

      {/* Blocking Caps */}
      <div>
        <h3 className={sectionTitleClass}>Blocking Caps</h3>
        <div className="flex items-center gap-4">
          <label className={`flex items-center gap-2 ${labelClass}`}>
            1 flag → cap:
            <input
              type="number"
              min="0"
              max="100"
              className={inputClass}
              value={settings.blocking_caps['1'] ?? 60}
              onChange={(e) =>
                updateSetting('blocking_caps', {
                  ...settings.blocking_caps,
                  '1': parseInt(e.target.value) || 0,
                })
              }
            />
          </label>
          <label className={`flex items-center gap-2 ${labelClass}`}>
            2+ flags → cap:
            <input
              type="number"
              min="0"
              max="100"
              className={inputClass}
              value={settings.blocking_caps['2'] ?? 40}
              onChange={(e) =>
                updateSetting('blocking_caps', {
                  ...settings.blocking_caps,
                  '2': parseInt(e.target.value) || 0,
                })
              }
            />
          </label>
        </div>
      </div>

      {/* Criteria Priority — drag & drop reorder + computed weights */}
      <div>
        <div className="mb-2 flex items-center gap-4">
          <h3 className={sectionTitleClass}>Criteria Priority</h3>
          <select
            className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
            value={settings.criteria_priority.preset}
            onChange={(e) =>
              updateSetting('criteria_priority', {
                ...settings.criteria_priority,
                preset: e.target.value,
              })
            }
          >
            <option value="flat">Flat</option>
            <option value="linear">Linear</option>
            <option value="steep">Steep</option>
          </select>
        </div>
        <div className="space-y-1">
          {settings.criteria_priority.order.map((key, idx) => {
            const w = weights[key] ?? 0;
            const barWidth = maxWeight > 0 ? (w / maxWeight) * 100 : 0;
            return (
              <div
                key={key}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                className={`flex items-center gap-3 rounded px-2 py-1 text-sm ${
                  dragIdx === idx
                    ? 'bg-[var(--bg-hover)] opacity-60'
                    : 'hover:bg-[var(--bg-hover)]'
                } cursor-grab`}
              >
                <span className="w-5 text-right text-[var(--text-secondary)]">{idx + 1}.</span>
                <span className="text-[var(--text-secondary)] select-none">⠿</span>
                <span className="w-48 text-[var(--text-primary)]">
                  {CRITERIA_LABELS[key] ?? key}
                </span>
                <div className="flex-1">
                  <div
                    className="h-3 rounded bg-[var(--accent)]"
                    style={{ width: `${barWidth}%`, opacity: 0.6 }}
                  />
                </div>
                <span className="w-14 text-right font-mono text-xs text-[var(--text-secondary)]">
                  {(w * 100).toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Concurrency & Other Settings */}
      <div>
        <h3 className={sectionTitleClass}>Judge Settings</h3>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3">
          <label className={`flex items-center justify-between ${labelClass}`}>
            Temperature:
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              className={inputClass}
              value={settings.judge_temperature}
              onChange={(e) => updateSetting('judge_temperature', parseFloat(e.target.value))}
            />
          </label>
          <label className={`flex items-center justify-between ${labelClass}`}>
            Max retries:
            <input
              type="number"
              min="1"
              max="10"
              className={inputClass}
              value={settings.judge_max_retries}
              onChange={(e) => updateSetting('judge_max_retries', parseInt(e.target.value))}
            />
          </label>
          <label className={`flex items-center justify-between ${labelClass}`}>
            Max concurrent / provider:
            <input
              type="number"
              min="1"
              max="20"
              className={inputClass}
              value={settings.judge_max_concurrent_per_provider ?? 3}
              onChange={(e) =>
                updateSetting('judge_max_concurrent_per_provider', parseInt(e.target.value))
              }
            />
          </label>
          <label className={`flex items-center justify-between ${labelClass}`}>
            Max concurrent global:
            <input
              type="number"
              min="1"
              max="50"
              className={inputClass}
              value={settings.judge_max_concurrent_global ?? 10}
              onChange={(e) =>
                updateSetting('judge_max_concurrent_global', parseInt(e.target.value))
              }
            />
          </label>
          <label className={`flex items-center justify-between ${labelClass}`}>
            Log compression:
            <select
              className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              value={settings.log_compression}
              onChange={(e) => updateSetting('log_compression', e.target.value)}
            >
              <option value="structured">Structured</option>
              <option value="none">None</option>
            </select>
          </label>
          <label className={`flex items-center justify-between ${labelClass}`}>
            Max compressed chars:
            <input
              type="number"
              min="1000"
              max="200000"
              step="1000"
              className={inputClass}
              value={settings.max_compressed_chars}
              onChange={(e) => updateSetting('max_compressed_chars', parseInt(e.target.value))}
            />
          </label>
          <label className={`flex items-center justify-between ${labelClass}`}>
            Max judge prompt chars:
            <input
              type="number"
              min="10000"
              max="500000"
              step="10000"
              className={inputClass}
              value={settings.max_judge_prompt_chars}
              onChange={(e) => updateSetting('max_judge_prompt_chars', parseInt(e.target.value))}
            />
          </label>
          <label className={`flex items-center justify-between ${labelClass}`}>
            Task idle timeout (sec):
            <input
              type="number"
              min="60"
              max="1800"
              step="30"
              className={inputClass}
              value={Math.round(settings.judge_task_idle_timeout_ms / 1000)}
              onChange={(e) =>
                updateSetting('judge_task_idle_timeout_ms', parseInt(e.target.value) * 1000)
              }
            />
          </label>
          <label className={`flex items-center justify-between ${labelClass}`}>
            Raw response retention (days):
            <input
              type="number"
              min="1"
              max="365"
              className={inputClass}
              value={settings.judge_raw_response_retention_days}
              onChange={(e) =>
                updateSetting('judge_raw_response_retention_days', parseInt(e.target.value))
              }
            />
          </label>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          onClick={saveSettings}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        <button
          className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          onClick={resetToDefaults}
          disabled={saving}
        >
          Reset to Defaults
        </button>
      </div>
    </section>
  );
}
