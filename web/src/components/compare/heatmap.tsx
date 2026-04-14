'use client';

import type { CompareResponse } from '@/lib/compare/types';
import { HeatmapCell } from './heatmap-cell';

interface Props {
  data: CompareResponse;
  onCellClick: (entityId: string, scenarioId: string) => void;
}

export function Heatmap({ data, onCellClick }: Props) {
  const { columns, rows, cells, totals } = data.heatmap;
  const leaderId = data.leaderboard[0]?.entityId;
  const rowLabel = data.lens === 'model-ranking' || data.lens === 'agent-x-models'
    ? 'Model'
    : 'Agent';

  if (rows.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-[var(--text-muted)]">
        No results yet. Run a benchmark to see comparisons.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-[var(--bg-raised)] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
              {rowLabel}
            </th>
            {columns.map((column) => (
              <th
                key={column.id}
                className="whitespace-nowrap px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]"
              >
                {column.name}
              </th>
            ))}
            <th
              title="Average across scored scenarios in this row"
              className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]"
            >
              Avg
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.id}
              className={`border-b border-[var(--border)] ${row.id === leaderId ? 'bg-[var(--accent-dim)]' : ''}`}
            >
              <td className="sticky left-0 z-10 bg-[var(--bg-raised)] px-3 py-1.5 font-mono text-xs font-medium whitespace-nowrap">
                <span className="mr-1 text-[var(--text-muted)]">#{index + 1}</span>
                {row.name}
              </td>
              {columns.map((column) => (
                <HeatmapCell
                  key={column.id}
                  cell={cells[row.id]?.[column.id] ?? null}
                  cellKey={`${row.id}:${column.id}`}
                  onClick={() => onCellClick(row.id, column.id)}
                />
              ))}
              <td className="px-2 py-1.5 text-center font-mono text-xs font-bold text-[var(--text-primary)]">
                {totals[row.id] !== undefined ? `${totals[row.id].toFixed(0)}%` : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
