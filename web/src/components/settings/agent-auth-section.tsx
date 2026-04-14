'use client';

import { useState, useEffect, useCallback } from 'react';

interface AuthMethodView {
  type: string;
  envVar: string;
  label: string;
  required: boolean;
  configured: boolean;
  maskedValue: string | null;
}

interface Props {
  agentId: string;
}

export function AgentAuthSection({ agentId }: Props) {
  const [methods, setMethods] = useState<AuthMethodView[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAuth = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/auth`);
      if (res.ok) {
        const data = await res.json();
        setMethods(data.authMethods ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { fetchAuth(); }, [fetchAuth]);

  const handleSave = async (envVar: string) => {
    const value = editing[envVar];
    if (!value?.trim()) return;

    setSaving(envVar);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/auth`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envVar, value: value.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      setEditing((prev) => { const next = { ...prev }; delete next[envVar]; return next; });
      await fetchAuth();
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (envVar: string) => {
    setSaving(envVar);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/auth`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envVar }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      await fetchAuth();
    } finally {
      setSaving(null);
    }
  };

  if (loading) return null;
  if (methods.length === 0) return null;

  const inputClass = `w-full px-3 py-1.5 rounded-md text-sm font-mono
    bg-[var(--bg-base)] border border-[var(--border)]
    text-[var(--text-primary)] placeholder:text-[var(--text-muted)]
    focus:outline-none focus:border-[var(--accent)]`;

  const labelClass = 'block text-xs font-mono text-[var(--text-secondary)] mb-1';

  const smallBtn = `px-2 py-1 text-xs font-mono rounded
    text-[var(--text-secondary)] hover:text-[var(--text-primary)]
    hover:bg-[var(--bg-hover)] transition-colors`;

  return (
    <div className="mt-4 pt-4 border-t border-[var(--border)]">
      <h4 className="text-xs font-mono text-[var(--text-muted)] uppercase tracking-wider mb-3">
        Authentication
      </h4>

      {error && (
        <div className="text-xs font-mono text-[var(--score-fail)] bg-[var(--score-fail-bg)] px-3 py-2 rounded-md mb-3">
          {error}
        </div>
      )}

      {methods.map((method) => {
        const envVar = method.envVar;

        return (
          <div key={envVar} className="mb-3">
            <label className={labelClass}>
              {method.label}
              {method.required && <span className="text-[var(--score-fail)] ml-1">*</span>}
            </label>

            {method.configured && !(envVar in editing) ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-[var(--text-muted)]">
                  {method.maskedValue}
                </span>
                <button
                  className={smallBtn}
                  onClick={() => setEditing((prev) => ({ ...prev, [envVar]: '' }))}
                >
                  Change
                </button>
                <button
                  className={`${smallBtn} hover:text-[var(--score-fail)]`}
                  onClick={() => handleDelete(envVar)}
                  disabled={saving === envVar}
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={editing[envVar] ?? ''}
                  onChange={(e) =>
                    setEditing((prev) => ({ ...prev, [envVar]: e.target.value }))
                  }
                  placeholder={`Enter ${method.label}`}
                  className={inputClass}
                />
                <button
                  onClick={() => handleSave(envVar)}
                  disabled={saving === envVar || !editing[envVar]?.trim()}
                  className="px-3 py-1.5 text-xs font-mono rounded-md
                    bg-[var(--accent)] text-[var(--bg-base)]
                    hover:opacity-90 transition-opacity
                    disabled:opacity-50 whitespace-nowrap"
                >
                  {saving === envVar ? '…' : 'Save'}
                </button>
                {method.configured && (
                  <button
                    className={smallBtn}
                    onClick={() =>
                      setEditing((prev) => { const next = { ...prev }; delete next[envVar]; return next; })
                    }
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
