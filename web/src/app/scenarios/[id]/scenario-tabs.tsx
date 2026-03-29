'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import type { ScenarioDetailResponse, ScenarioFile } from '@/lib/scenarios/types';

interface Props {
  data: ScenarioDetailResponse;
}

const TABS = [
  { key: 'prompt', label: 'Prompt', file: 'prompt.txt' },
  { key: 'task', label: 'Task', file: 'task.txt' },
  { key: 'scoring', label: 'Scoring', file: 'scoring.csv' },
  { key: 'project', label: 'Project', file: null },
  { key: 'tests', label: 'Tests', file: null },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function ScenarioTabs({ data }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('prompt');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchFile = useCallback(async (path: string) => {
    setFileLoading(true);
    setFileContent(null);
    try {
      const res = await fetch(`/api/scenarios/${data.id}/files?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const json = await res.json();
        setFileContent(json.content);
      } else {
        setFileContent(null);
      }
    } catch {
      setFileContent(null);
    } finally {
      setFileLoading(false);
    }
  }, [data.id]);

  useEffect(() => {
    const tab = TABS.find((t) => t.key === activeTab);
    if (tab?.file) {
      fetchFile(tab.file);
    } else {
      setFileContent(null);
    }
    setEditing(false);
  }, [activeTab, fetchFile]);

  const handleSaveFile = useCallback(async (path: string, content: string) => {
    setSaving(true);
    await fetch(`/api/scenarios/${data.id}/files`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    setFileContent(content);
    setEditing(false);
    setSaving(false);
  }, [data.id]);

  // Categorize files for project/tests tabs using path-based convention
  const projectFiles = data.files.filter((f) => f.key.startsWith('project/'));
  const testFiles = data.files.filter((f) => f.key.startsWith('project/tests/'));
  const currentFiles =
    activeTab === 'project'
      ? projectFiles
      : activeTab === 'tests'
        ? testFiles
        : [];

  const currentTab = TABS.find((t) => t.key === activeTab);

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
        {fileLoading && (
          <div className="text-sm text-[var(--text-muted)]">Loading…</div>
        )}

        {/* Single file tabs (prompt, task, scoring) */}
        {!fileLoading && currentTab?.file && (
          <SingleFileView
            fileContent={fileContent}
            filePath={currentTab.file}
            editing={editing}
            editContent={editContent}
            saving={saving}
            onStartEdit={() => {
              setEditContent(fileContent ?? '');
              setEditing(true);
            }}
            onCancelEdit={() => setEditing(false)}
            onChangeEdit={setEditContent}
            onSave={() => handleSaveFile(currentTab.file!, editContent)}
          />
        )}

        {/* Directory tabs (project, tests) */}
        {!fileLoading && !currentTab?.file && (
          <FileList
            files={currentFiles}
            onSelect={(path) => fetchFile(path)}
            selectedContent={fileContent}
          />
        )}
      </Card>
    </>
  );
}

/** Viewer/editor for single-file tabs, with "Create File" when file doesn't exist */
function SingleFileView({
  fileContent,
  filePath,
  editing,
  editContent,
  saving,
  onStartEdit,
  onCancelEdit,
  onChangeEdit,
  onSave,
}: {
  fileContent: string | null;
  filePath: string;
  editing: boolean;
  editContent: string;
  saving: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeEdit: (v: string) => void;
  onSave: () => void;
}) {
  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          value={editContent}
          onChange={(e) => onChangeEdit(e.target.value)}
          rows={20}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3 font-mono text-xs text-[var(--text-primary)]"
        />
        <div className="flex gap-2">
          <button
            onClick={onSave}
            disabled={saving}
            className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={onCancelEdit}
            className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-secondary)]"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (fileContent !== null) {
    return (
      <div>
        <div className="mb-2 flex justify-end">
          <button
            onClick={onStartEdit}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            Edit
          </button>
        </div>
        <pre className="whitespace-pre-wrap font-mono text-xs text-[var(--text-primary)] leading-relaxed">
          {fileContent}
        </pre>
      </div>
    );
  }

  // File doesn't exist — offer to create it
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <p className="mb-3 text-sm text-[var(--text-muted)]">
        <code className="text-[var(--text-secondary)]">{filePath}</code> does not exist yet.
      </p>
      <button
        onClick={onStartEdit}
        className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        Create File
      </button>
    </div>
  );
}

/** File listing for project/tests tabs */
function FileList({
  files,
  onSelect,
  selectedContent,
}: {
  files: ScenarioFile[];
  onSelect: (path: string) => void;
  selectedContent: string | null;
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  if (files.length === 0) {
    return <div className="text-sm text-[var(--text-muted)]">No files in this category.</div>;
  }

  return (
    <div className="flex gap-3">
      <div className="w-48 flex-shrink-0 space-y-1 border-r border-[var(--border)] pr-3">
        {files.map((f) => (
          <button
            key={f.key}
            onClick={() => {
              setSelectedFile(f.key);
              onSelect(f.key);
            }}
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
        {selectedFile && selectedContent !== null ? (
          <pre className="whitespace-pre-wrap font-mono text-xs text-[var(--text-primary)] leading-relaxed">
            {selectedContent}
          </pre>
        ) : selectedFile ? (
          <div className="text-sm text-[var(--text-muted)]">Loading…</div>
        ) : (
          <div className="text-sm text-[var(--text-muted)]">Select a file to view its contents.</div>
        )}
      </div>
    </div>
  );
}
