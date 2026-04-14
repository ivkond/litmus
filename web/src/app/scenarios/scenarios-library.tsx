'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ScenarioListItem } from '@/lib/scenarios/types';

interface Props {
  scenarios: ScenarioListItem[];
}

export function ScenariosLibrary({ scenarios }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({ slug: '', name: '', language: '', description: '' });

  const filtered = scenarios.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.slug.toLowerCase().includes(search.toLowerCase()) ||
      (s.language ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((s) => s.id)));
    }
  }, [filtered, selected.size]);

  const handleImport = useCallback(async (file: File) => {
    setImporting(true);
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/scenarios/import', { method: 'POST', body: formData });
    if (res.ok) {
      router.refresh();
    }
    setImporting(false);
  }, [router]);

  const handleCreate = useCallback(async () => {
    if (!form.slug || !form.name) return;
    const res = await fetch('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setCreating(false);
      setForm({ slug: '', name: '', language: '', description: '' });
      router.refresh();
    }
  }, [form, router]);

  const handleExport = useCallback(async () => {
    // Export selected scenarios; if none selected, export all
    const ids = selected.size > 0
      ? Array.from(selected)
      : scenarios.map((s) => s.id);
    const res = await fetch(`/api/scenarios/export?ids=${ids.join(',')}`);
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `scenarios-${Date.now()}.litmus-pack`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [scenarios, selected]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-lg text-[var(--text-primary)]">Scenarios</h1>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {scenarios.length} {scenarios.length === 1 ? 'scenario' : 'scenarios'}
          </span>
        </div>
      </div>

      {/* Actions bar */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Search scenarios…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
        <label className="cursor-pointer rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
          {importing ? 'Importing…' : 'Import Pack'}
          <input
            type="file"
            accept=".litmus-pack,.zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImport(file);
            }}
          />
        </label>
        {scenarios.length > 0 && (
          <button
            onClick={handleExport}
            className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            {selected.size > 0 ? `Export ${selected.size} Selected` : 'Export All'}
          </button>
        )}
        <button
          onClick={() => setCreating(!creating)}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          + New Scenario
        </button>
      </div>

      {/* Selection controls */}
      {scenarios.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <button onClick={selectAll} className="underline hover:text-[var(--text-secondary)]">
            {selected.size === filtered.length ? 'Deselect all' : 'Select all'}
          </button>
          {selected.size > 0 && (
            <span>{selected.size} selected</span>
          )}
        </div>
      )}

      {/* Create form */}
      {creating && (
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Slug (e.g. 1-data-structure)"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
            <input
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
            <input
              placeholder="Language (e.g. python)"
              value={form.language}
              onChange={(e) => setForm({ ...form, language: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
            <input
              placeholder="Description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!form.slug || !form.name}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Create
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)]"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}

      {/* Scenario grid */}
      {filtered.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--text-muted)]">
            {scenarios.length === 0
              ? 'No scenarios yet. Import a pack or create a new scenario.'
              : 'No scenarios match your search.'}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => (
            <div key={s.id} className="relative">
              {/* Selection checkbox */}
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggleSelect(s.id)}
                className="absolute left-2 top-2 z-10"
                aria-label={`Select ${s.name}`}
              />
              <Link href={`/scenarios/${s.id}`}>
                <Card hover className="h-full pl-8">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-semibold text-[var(--text-primary)] truncate">
                        {s.name}
                      </div>
                      <code className="text-[0.65rem] text-[var(--text-muted)]">{s.slug}</code>
                    </div>
                    {s.version && (
                      <Badge>{s.version}</Badge>
                    )}
                  </div>
                  {s.description && (
                    <p className="mt-2 text-xs text-[var(--text-secondary)] line-clamp-2">
                      {s.description}
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    {s.language && <Badge variant="accent">{s.language}</Badge>}
                    {(s.tags ?? []).slice(0, 2).map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-4 text-[0.65rem] text-[var(--text-muted)]">
                    <span>{s.totalRuns} runs</span>
                    {s.avgScore != null && (
                      <span>avg {s.avgScore.toFixed(0)}%</span>
                    )}
                  </div>
                </Card>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
