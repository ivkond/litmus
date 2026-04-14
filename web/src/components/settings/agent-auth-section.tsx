'use client';

import { useState, useEffect, useCallback } from 'react';

interface AuthMethodView {
  id: string;
  type: string;
  description?: string;
  vars?: Array<{ name: string; description?: string }>;
  configured: boolean;
  oauthCapable: boolean;
  maskedValues: Record<string, string> | null;
}

interface Props {
  agentId: string;
}

export function AgentAuthSection({ agentId }: Props) {
  const [methods, setMethods] = useState<AuthMethodView[]>([]);
  const [editing, setEditing] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

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

  const handleSave = async (methodId: string) => {
    const values = editing[methodId];
    if (!values || Object.keys(values).length === 0) return;

    setSaving(methodId);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/auth`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ methodId, type: 'api_key', values }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      setEditing((prev) => { const next = { ...prev }; delete next[methodId]; return next; });
      await fetchAuth();
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (methodId: string) => {
    setSaving(methodId);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/auth`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ methodId }),
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

  const handleOAuth = async (methodId: string) => {
    setOauthLoading(methodId);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/auth/oauth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ methodId }),
      });

      const reader = res.body?.getReader();
      if (!reader) {
        setError('Failed to start OAuth flow');
        return;
      }

      const decoder = new TextDecoder();
      let done = false;

      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6));
                if (event.type === 'failed') {
                  setError(event.error);
                  done = true;
                } else if (event.type === 'completed') {
                  await fetchAuth();
                  done = true;
                }
              } catch {
                // Skip invalid JSON
              }
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OAuth failed');
    } finally {
      setOauthLoading(null);
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
        const isEnvVar = method.type === 'env_var';
        const isOAuth = method.oauthCapable && !method.configured;

        return (
          <div key={method.id} className="mb-4 pb-3 border-b border-[var(--border)] last:border-0">
            <label className={labelClass}>
              {method.description ?? method.id}
              {isEnvVar && <span className="text-[var(--score-fail)] ml-1">*</span>}
            </label>

            {isEnvVar && method.vars && (
              <div className="space-y-2">
                {method.vars.map((v) => {
                  const varName = v.name;
                  const currentValue = editing[method.id]?.[varName] ?? '';
                  const existingValue = method.maskedValues?.[varName];

                  return (
                    <div key={varName} className="flex items-center gap-2">
                      <span className="text-xs font-mono text-[var(--text-muted)] w-32">{varName}</span>
                      {existingValue && !(method.id in editing) ? (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-[var(--text-muted)]">
                            {existingValue}
                          </span>
                          <button
                            className={smallBtn}
                            onClick={() => setEditing((prev) => ({ ...prev, [method.id]: { [varName]: '' } }))}
                          >
                            Change
                          </button>
                          <button
                            className={`${smallBtn} hover:text-[var(--score-fail)]`}
                            onClick={() => handleDelete(method.id)}
                            disabled={saving === method.id}
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            value={currentValue}
                            onChange={(e) =>
                              setEditing((prev) => ({
                                ...prev,
                                [method.id]: { ...prev[method.id], [varName]: e.target.value },
                              }))
                            }
                            placeholder={`Enter ${varName}`}
                            className={inputClass}
                          />
                          <button
                            onClick={() => handleSave(method.id)}
                            disabled={saving === method.id || !currentValue.trim()}
                            className="px-3 py-1.5 text-xs font-mono rounded-md
                              bg-[var(--accent)] text-[var(--bg-base)]
                              hover:opacity-90 transition-opacity
                              disabled:opacity-50 whitespace-nowrap"
                          >
                            {saving === method.id ? '…' : 'Save'}
                          </button>
                          {method.configured && (
                            <button
                              className={smallBtn}
                              onClick={() =>
                                setEditing((prev) => { const next = { ...prev }; delete next[method.id]; return next; })
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
            )}

            {isOAuth && !method.configured && (
              <div className="mt-2">
                <button
                  onClick={() => handleOAuth(method.id)}
                  disabled={oauthLoading === method.id}
                  className="px-3 py-1.5 text-xs font-mono rounded-md
                    bg-[var(--accent-dim)] text-[var(--accent)]
                    hover:opacity-90 transition-opacity
                    disabled:opacity-50"
                >
                  {oauthLoading === method.id ? 'Authenticating...' : 'Authenticate via Browser'}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
