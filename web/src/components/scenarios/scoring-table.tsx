'use client';

import { useState, useCallback } from 'react';
import { parseCSV, serializeCSV } from '@/lib/csv';

const DEFAULT_HEADERS = ['criterion', 'weight', 'description'];

interface Props {
  /** Raw CSV content from S3, or null if file doesn't exist */
  content: string | null;
  /** Called with serialized CSV string */
  onSave: (csv: string) => Promise<void>;
  saving: boolean;
}

export function ScoringTable({ content, onSave, saving }: Props) {
  const parsed = content !== null ? parseCSV(content) : null;

  const [editing, setEditing] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);

  const startEdit = useCallback(() => {
    if (parsed) {
      setHeaders([...parsed.headers]);
      setRows(parsed.rows.map((r) => [...r]));
    } else {
      setHeaders([...DEFAULT_HEADERS]);
      setRows([['', '', '']]);
    }
    setEditing(true);
  }, [parsed]);

  const cancelEdit = useCallback(() => setEditing(false), []);

  const handleSave = useCallback(async () => {
    // Filter out completely empty rows
    const nonEmpty = rows.filter((row) => row.some((cell) => cell.trim() !== ''));
    await onSave(serializeCSV(headers, nonEmpty));
    setEditing(false);
  }, [headers, rows, onSave]);

  const updateCell = useCallback((rowIdx: number, colIdx: number, value: string) => {
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      next[rowIdx][colIdx] = value;
      return next;
    });
  }, []);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, headers.map(() => '')]);
  }, [headers]);

  const removeRow = useCallback((idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // --- File doesn't exist yet ---
  if (content === null && !editing) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="mb-3 text-sm text-[var(--text-muted)]">
          <code className="text-[var(--text-secondary)]">scoring.csv</code> does not exist yet.
        </p>
        <button
          onClick={startEdit}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Create Scoring Table
        </button>
      </div>
    );
  }

  // --- Editing mode ---
  if (editing) {
    return (
      <div className="space-y-3">
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr>
                {headers.map((h, i) => (
                  <th
                    key={i}
                    className="border border-[var(--border)] bg-[var(--bg-hover)] px-2 py-1.5
                      text-left font-semibold text-[var(--text-secondary)]"
                  >
                    {h}
                  </th>
                ))}
                <th className="w-8 border border-[var(--border)] bg-[var(--bg-hover)]" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {row.map((cell, colIdx) => (
                    <td key={colIdx} className="border border-[var(--border)] p-0">
                      <input
                        type="text"
                        value={cell}
                        onChange={(e) => updateCell(rowIdx, colIdx, e.target.value)}
                        className="w-full bg-transparent px-2 py-1.5 text-xs font-mono
                          text-[var(--text-primary)] outline-none
                          focus:bg-[var(--bg-base)]"
                      />
                    </td>
                  ))}
                  <td className="border border-[var(--border)] text-center">
                    <button
                      onClick={() => removeRow(rowIdx)}
                      className="px-1.5 py-0.5 text-[var(--score-fail)] hover:bg-[var(--score-fail-bg)]
                        rounded text-xs"
                      title="Remove row"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={addRow}
            className="rounded border border-dashed border-[var(--border)] px-3 py-1
              text-xs font-mono text-[var(--text-secondary)]
              hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            + Add Row
          </button>
          <div className="flex-1" />
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={cancelEdit}
            className="rounded border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-secondary)]"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // --- View mode (parsed table) ---
  if (!parsed || parsed.headers.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-[var(--text-muted)] mb-3">
          scoring.csv is empty or has invalid format.
        </p>
        <button
          onClick={startEdit}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button
          onClick={startEdit}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          Edit
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono border-collapse">
          <thead>
            <tr>
              {parsed.headers.map((h, i) => (
                <th
                  key={i}
                  className="border border-[var(--border)] bg-[var(--bg-hover)] px-3 py-2
                    text-left font-semibold text-[var(--text-secondary)] uppercase tracking-wide"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {parsed.rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-[var(--bg-hover)] transition-colors">
                {row.map((cell, colIdx) => (
                  <td
                    key={colIdx}
                    className="border border-[var(--border)] px-3 py-2 text-[var(--text-primary)]"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {parsed.rows.length === 0 && (
        <p className="text-center text-sm text-[var(--text-muted)] py-4">
          No scoring criteria defined.
        </p>
      )}
    </div>
  );
}
