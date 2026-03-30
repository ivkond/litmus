'use client';

import { useState, useCallback } from 'react';

export interface AgentWithExecutors {
  id: string;
  name: string;
  version: string | null;
  availableModels: unknown[];
  createdAt: Date | null;
  executors: Array<{
    id: string;
    agentId: string;
    type: string;
    agentSlug: string;
    binaryPath: string | null;
    healthCheck: string | null;
    config: unknown;
    createdAt: Date | null;
  }>;
}

interface Props {
  agent?: AgentWithExecutors;
  onSave: () => Promise<void>;
  onCancel: () => void;
}

export function AgentForm({ agent, onSave, onCancel }: Props) {
  const isEdit = !!agent;
  const executor = agent?.executors[0];

  const [form, setForm] = useState({
    name: agent?.name ?? '',
    version: agent?.version ?? '',
    type: executor?.type ?? 'docker',
    agentSlug: executor?.agentSlug ?? '',
    binaryPath: executor?.binaryPath ?? '',
    healthCheck: executor?.healthCheck ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In edit mode with existing executor, slug is pre-filled and locked.
  // In edit mode without executor, slug is editable (new executor will be created).
  // In create mode, slug is always editable.
  const slugLocked = isEdit && !!executor;
  const canSave = form.name.trim() !== '' && form.agentSlug.trim() !== '';

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const url = isEdit ? `/api/agents/${agent.id}` : '/api/agents';
      const method = isEdit ? 'PUT' : 'POST';

      const body = {
        name: form.name,
        version: form.version || undefined,
        executor: {
          type: form.type,
          agentSlug: form.agentSlug,
          binaryPath: form.binaryPath || undefined,
          healthCheck: form.healthCheck || undefined,
        },
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ? JSON.stringify(data.error) : `Request failed (${res.status})`);
        return;
      }

      await onSave();
    } finally {
      setSaving(false);
    }
  }, [canSave, isEdit, agent?.id, form, onSave]);

  const inputClass = `w-full px-3 py-1.5 rounded-md text-sm font-mono
    bg-[var(--bg-base)] border border-[var(--border)]
    text-[var(--text-primary)] placeholder:text-[var(--text-muted)]
    focus:outline-none focus:border-[var(--accent)]`;

  const labelClass = 'block text-xs font-mono text-[var(--text-secondary)] mb-1';

  return (
    <div className="space-y-3">
      {error && (
        <div className="text-xs font-mono text-[var(--score-fail)] bg-[var(--score-fail-bg)] px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="agent-name" className={labelClass}>Name</label>
          <input
            id="agent-name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Claude Code"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="agent-version" className={labelClass}>Version</label>
          <input
            id="agent-version"
            value={form.version}
            onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
            placeholder="e.g. 1.0"
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="agent-slug" className={labelClass}>Agent Slug</label>
          <input
            id="agent-slug"
            value={form.agentSlug}
            onChange={(e) => setForm((f) => ({ ...f, agentSlug: e.target.value }))}
            placeholder="e.g. claude-code"
            className={inputClass}
            disabled={slugLocked}
          />
          {slugLocked && (
            <span className="text-[10px] text-[var(--text-muted)]">Slug cannot be changed after creation</span>
          )}
        </div>
        <div>
          <label htmlFor="executor-type" className={labelClass}>Executor Type</label>
          <select
            id="executor-type"
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            className={inputClass}
          >
            <option value="docker">Docker</option>
            <option value="host">Host</option>
            <option value="kubernetes">Kubernetes</option>
          </select>
        </div>
      </div>

      {form.type === 'host' && (
        <div>
          <label htmlFor="binary-path" className={labelClass}>Binary Path</label>
          <input
            id="binary-path"
            value={form.binaryPath}
            onChange={(e) => setForm((f) => ({ ...f, binaryPath: e.target.value }))}
            placeholder="/usr/local/bin/claude"
            className={inputClass}
          />
        </div>
      )}

      <div>
        <label htmlFor="health-check" className={labelClass}>Health Check Command</label>
        <input
          id="health-check"
          value={form.healthCheck}
          onChange={(e) => setForm((f) => ({ ...f, healthCheck: e.target.value }))}
          placeholder="e.g. cursor --version"
          className={inputClass}
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm font-mono rounded-md
            text-[var(--text-secondary)] hover:text-[var(--text-primary)]
            hover:bg-[var(--bg-hover)] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="px-3 py-1.5 text-sm font-mono rounded-md
            bg-[var(--accent)] text-[var(--bg-base)]
            hover:opacity-90 transition-opacity
            disabled:opacity-50"
        >
          {saving ? 'Saving…' : isEdit ? 'Update' : 'Save'}
        </button>
      </div>
    </div>
  );
}
