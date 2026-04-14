'use client';

import { useState, useCallback, useEffect } from 'react';

export interface GeneralSettingsData {
  theme: 'light' | 'dark' | 'system';
  autoJudge: boolean;
  maxConcurrentLanes: number;
}

interface Props {
  initialSettings: GeneralSettingsData;
}

export function GeneralSettings({ initialSettings }: Props) {
  // Theme: prefer localStorage (set by ThemeToggle) over server value on mount
  const [settings, setSettings] = useState(() => {
    if (typeof window === 'undefined') return initialSettings;
    const stored = localStorage.getItem('litmus-theme') as GeneralSettingsData['theme'] | null;
    return stored ? { ...initialSettings, theme: stored } : initialSettings;
  });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const update = useCallback(<K extends keyof GeneralSettingsData>(key: K, value: GeneralSettingsData[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const applyTheme = useCallback((theme: string) => {
    if (typeof window === 'undefined') return;
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    localStorage.setItem('litmus-theme', theme);
    // Notify ThemeToggle (useSyncExternalStore subscribes to storage events)
    window.dispatchEvent(new StorageEvent('storage', { key: 'litmus-theme' }));
  }, []);

  // Only apply theme on explicit user changes, not on mount
  useEffect(() => {
    if (!mounted) return;
    applyTheme(settings.theme);
  }, [settings.theme, applyTheme, mounted]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/scoring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          general_theme: settings.theme,
          general_auto_judge: settings.autoJudge,
          general_max_concurrent_lanes: settings.maxConcurrentLanes,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        // PUT /api/settings/scoring returns { errors: string[] } on 422
        const msg = Array.isArray(data?.errors) ? data.errors.join('; ') : `Save failed (${res.status})`;
        setError(msg);
        return;
      }
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const inputClass = `w-full px-3 py-1.5 rounded-md text-sm font-mono
    bg-[var(--bg-base)] border border-[var(--border)]
    text-[var(--text-primary)]
    focus:outline-none focus:border-[var(--accent)]`;

  const labelClass = 'block text-xs font-mono text-[var(--text-secondary)] mb-1';

  return (
    <section>
      <h2 className="text-lg font-semibold font-mono text-[var(--text-primary)] mb-4">General</h2>

      {error && (
        <div className="text-xs font-mono text-[var(--score-fail)] bg-[var(--score-fail-bg)] px-3 py-2 rounded-md mb-4">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div className="max-w-xs">
          <label htmlFor="theme-select" className={labelClass}>Theme</label>
          <select
            id="theme-select"
            value={settings.theme}
            onChange={(e) => update('theme', e.target.value as GeneralSettingsData['theme'])}
            className={inputClass}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="auto-judge"
            checked={settings.autoJudge}
            onChange={(e) => update('autoJudge', e.target.checked)}
            className="rounded border-[var(--border)] bg-[var(--bg-base)] text-[var(--accent)]
              focus:ring-[var(--accent)] focus:ring-offset-0"
          />
          <label htmlFor="auto-judge" className="text-sm font-mono text-[var(--text-primary)]">
            Auto-run judge after benchmark
          </label>
        </div>

        <div className="max-w-xs">
          <label htmlFor="max-lanes" className={labelClass}>Parallel Execution (max concurrent lanes)</label>
          <input
            type="number"
            id="max-lanes"
            min={1}
            max={10}
            value={settings.maxConcurrentLanes}
            onChange={(e) => update('maxConcurrentLanes', Number(e.target.value))}
            className={inputClass}
          />
        </div>

        {dirty && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm font-mono rounded-md
              bg-[var(--accent)] text-[var(--bg-base)]
              hover:opacity-90 transition-opacity
              disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        )}
      </div>
    </section>
  );
}
