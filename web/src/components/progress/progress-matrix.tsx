'use client';

export type CellStatus = 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'error' | 'cancelled';

export interface CellData {
  status: CellStatus;
  score?: number;
  attempt?: number;
  maxAttempts?: number;
}

export function cellKey(agent: string, model: string, scenario: string): string {
  return `${agent}\x00${model}\x00${scenario}`;
}

interface ProgressMatrixProps {
  rows: Array<{ agent: string; model: string }>;
  columns: string[];
  cells: Map<string, CellData>;
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-[var(--score-excellent)]';
  if (score >= 60) return 'text-[var(--accent)]';
  if (score >= 40) return 'text-[var(--score-mid)]';
  return 'text-[var(--score-fail)]';
}

function Cell({ data }: { data: CellData | undefined }) {
  if (!data || data.status === 'pending') {
    return <span className="text-[var(--text-muted)]">—</span>;
  }

  if (data.status === 'running') {
    return (
      <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
    );
  }

  if (data.status === 'retrying') {
    return (
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        {data.attempt != null && data.maxAttempts != null && (
          <span className="font-mono text-xs text-amber-400">{data.attempt}/{data.maxAttempts}</span>
        )}
      </span>
    );
  }

  if (data.status === 'completed') {
    const score = data.score ?? 0;
    return (
      <span className={`font-mono text-xs font-semibold ${scoreColor(score)}`}>
        {score}
      </span>
    );
  }

  if (data.status === 'failed') {
    const score = data.score ?? 0;
    return (
      <span className="flex items-center gap-1">
        <span className={`font-mono text-xs font-semibold text-[var(--score-fail)]`}>{score}</span>
        <span className="text-[var(--score-fail)] text-xs" title="Tests failed">⚠</span>
      </span>
    );
  }

  if (data.status === 'error') {
    return <span className="font-mono text-xs text-[var(--score-fail)]">✕</span>;
  }

  if (data.status === 'cancelled') {
    return <span className="text-[var(--text-muted)]">/</span>;
  }

  return null;
}

export function ProgressMatrix({ rows, columns, cells }: ProgressMatrixProps) {
  if (rows.length === 0 || columns.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)]">Waiting for tasks to start…</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-[var(--bg-raised)] border border-[var(--border)] px-3 py-2 text-left font-mono text-xs text-[var(--text-muted)] min-w-[160px]">
              Agent × Model
            </th>
            {columns.map((scenario) => (
              <th
                key={scenario}
                className="border border-[var(--border)] px-3 py-2 font-mono text-xs text-[var(--text-muted)] whitespace-nowrap"
              >
                {scenario}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ agent, model }) => (
            <tr key={`${agent}\x00${model}`}>
              <td className="sticky left-0 z-10 bg-[var(--bg-raised)] border border-[var(--border)] px-3 py-2 font-mono text-xs text-[var(--text-secondary)] whitespace-nowrap min-w-[160px]">
                {agent} × {model}
              </td>
              {columns.map((scenario) => {
                const key = cellKey(agent, model, scenario);
                return (
                  <td
                    key={scenario}
                    className="border border-[var(--border)] px-3 py-2 text-center"
                  >
                    <Cell data={cells.get(key)} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
