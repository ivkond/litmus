'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import type { ScenarioDetailResponse, ScenarioFile } from '@/lib/scenarios/types';

interface Props {
  data: ScenarioDetailResponse;
}

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'project', label: 'Project' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const CONTENT_FIELDS = [
  { field: 'prompt' as const, label: 'Prompt' },
  { field: 'task' as const, label: 'Task' },
  { field: 'scoring' as const, label: 'Scoring' },
];

export function ScenarioTabs({ data }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('general');

  return (
    <>
      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-mono ${
              activeTab === tab.key
                ? 'border-b-2 border-[var(--accent)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <Card className="mt-2 min-h-[400px]">
        {activeTab === 'general' && (
          <GeneralTab data={data} />
        )}
        {activeTab === 'project' && (
          <FileList files={data.files} scenarioId={data.id} />
        )}
      </Card>
    </>
  );
}

/** General tab: prompt, task, scoring from DB as collapsible sections */
function GeneralTab({ data }: { data: ScenarioDetailResponse }) {
  const router = useRouter();

  const handleSave = useCallback(
    async (field: string, content: string) => {
      await fetch(`/api/scenarios/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: content }),
      });
      router.refresh();
    },
    [data.id, router],
  );

  return (
    <div className="space-y-4">
      {CONTENT_FIELDS.map(({ field, label }) => (
        <ContentSection
          key={field}
          label={label}
          content={data[field]}
          onSave={(content) => handleSave(field, content)}
        />
      ))}
    </div>
  );
}

/** A single collapsible section for a DB text field */
function ContentSection({
  label,
  content,
  onSave,
}: {
  label: string;
  content: string | null;
  onSave: (content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    await onSave(editContent);
    setEditing(false);
    setSaving(false);
  }, [editContent, onSave]);

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-4 py-2 bg-[var(--bg-overlay)] hover:bg-[var(--bg-hover)] transition-colors"
      >
        <span className="font-mono text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          {label}
        </span>
        <span className="text-[var(--text-muted)] text-xs">
          {collapsed ? '▸' : '▾'}
        </span>
      </button>

      {!collapsed && (
        <div className="px-4 py-3">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={12}
                className="w-full rounded border border-[var(--border)] bg-[var(--bg-base)] p-3 font-mono text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--bg-base)] disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-secondary)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : content !== null ? (
            <div>
              <div className="mb-2 flex justify-end">
                <button
                  onClick={() => { setEditContent(content); setEditing(true); }}
                  className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  Edit
                </button>
              </div>
              <pre className="whitespace-pre-wrap font-mono text-xs text-[var(--text-primary)] leading-relaxed">
                {content}
              </pre>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="mb-3 text-sm text-[var(--text-muted)]">
                Not set yet.
              </p>
              <button
                onClick={() => { setEditContent(''); setEditing(true); }}
                className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-base)] hover:opacity-90"
              >
                Add Content
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** File listing for project tab with file viewer */
function FileList({ files, scenarioId }: { files: ScenarioFile[]; scenarioId: string }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSelect = useCallback(
    async (filePath: string) => {
      setSelectedFile(filePath);
      setLoading(true);
      try {
        const res = await fetch(`/api/scenarios/${scenarioId}/files?path=${encodeURIComponent(filePath)}`);
        if (res.ok) {
          const json = await res.json();
          setContent(json.content);
        } else {
          setContent(null);
        }
      } catch {
        setContent(null);
      } finally {
        setLoading(false);
      }
    },
    [scenarioId],
  );

  if (files.length === 0) {
    return <div className="text-sm text-[var(--text-muted)]">No project files.</div>;
  }

  return (
    <div className="flex gap-3">
      <div className="w-48 flex-shrink-0 space-y-1 border-r border-[var(--border)] pr-3">
        {files.map((f) => (
          <button
            key={f.key}
            onClick={() => handleSelect(f.key)}
            className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-xs ${
              selectedFile === f.key
                ? 'bg-[var(--accent-dim)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            {f.name}
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0">
        {loading ? (
          <div className="text-sm text-[var(--text-muted)]">Loading…</div>
        ) : selectedFile && content !== null ? (
          <pre className="whitespace-pre-wrap font-mono text-xs text-[var(--text-primary)] leading-relaxed">
            {content}
          </pre>
        ) : (
          <div className="text-sm text-[var(--text-muted)]">Select a file to view its contents.</div>
        )}
      </div>
    </div>
  );
}
