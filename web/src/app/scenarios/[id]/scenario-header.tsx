'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import type { ScenarioDetailResponse } from '@/lib/scenarios/types';

interface Props {
  data: ScenarioDetailResponse;
}

export function ScenarioHeader({ data }: Props) {
  const router = useRouter();
  const [editMeta, setEditMeta] = useState(false);
  const [saving, setSaving] = useState(false);
  const [metaForm, setMetaForm] = useState({
    name: data.name,
    description: data.description ?? '',
    version: data.version ?? 'v1',
    language: data.language ?? '',
    maxScore: data.maxScore ?? 100,
  });

  const handleSaveMeta = useCallback(async () => {
    setSaving(true);
    const res = await fetch(`/api/scenarios/${data.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metaForm),
    });
    if (res.ok) {
      setEditMeta(false);
      router.refresh();
    }
    setSaving(false);
  }, [data.id, metaForm, router]);

  const handleDelete = useCallback(async () => {
    if (!confirm(`Delete scenario "${data.name}"? This cannot be undone.`)) return;
    await fetch(`/api/scenarios/${data.id}`, { method: 'DELETE' });
    router.push('/scenarios');
  }, [data.id, data.name, router]);

  return (
    <>
      {/* Breadcrumb + actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/scenarios" className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            Scenarios
          </Link>
          <span className="text-[var(--text-muted)]">/</span>
          <span className="font-mono text-[var(--text-primary)]">{data.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditMeta(!editMeta)}
            className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            Edit Metadata
          </button>
          <button
            onClick={handleDelete}
            className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--score-fail)] hover:bg-[var(--bg-hover)]"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Metadata edit form */}
      {editMeta && (
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-[var(--text-secondary)]">
              Name
              <input
                value={metaForm.name}
                onChange={(e) => setMetaForm({ ...metaForm, name: e.target.value })}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              Version
              <input
                value={metaForm.version}
                onChange={(e) => setMetaForm({ ...metaForm, version: e.target.value })}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              Language
              <input
                value={metaForm.language}
                onChange={(e) => setMetaForm({ ...metaForm, language: e.target.value })}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
            <label className="text-xs text-[var(--text-secondary)]">
              Max Score
              <input
                type="number"
                value={metaForm.maxScore}
                onChange={(e) => setMetaForm({ ...metaForm, maxScore: parseInt(e.target.value) })}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
            <label className="col-span-2 text-xs text-[var(--text-secondary)]">
              Description
              <textarea
                value={metaForm.description}
                onChange={(e) => setMetaForm({ ...metaForm, description: e.target.value })}
                rows={2}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
              />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSaveMeta}
              disabled={saving}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => setEditMeta(false)}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)]"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}
    </>
  );
}
