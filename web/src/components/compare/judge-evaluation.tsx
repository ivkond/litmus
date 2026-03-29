'use client';

import { useState } from 'react';
import { CRITERIA, BLOCKING_CHECKS } from '@/lib/judge/criteria';

interface Verdict {
  providerName: string;
  scores: Record<string, { score: number; rationale: string }>;
  blocking: Record<string, { triggered: boolean; rationale: string }>;
  error: string | null;
}

interface Props {
  judgeStatus: string;
  compositeScore: number | null;
  testScore: number;
  blockingFlags: Record<string, boolean> | null;
  verdicts: Verdict[] | null;
  weights: { test: number; judge: number };
}

export function JudgeEvaluation({
  judgeStatus,
  compositeScore,
  testScore,
  blockingFlags,
  verdicts,
  weights,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  if (judgeStatus === 'skipped') {
    return (
      <div className="mt-4 text-sm text-[var(--text-muted)]">
        Judge evaluation skipped (no providers configured)
      </div>
    );
  }

  if (judgeStatus === 'pending') {
    return (
      <div className="mt-4 text-sm text-[var(--text-secondary)]">
        ⏳ Judge evaluation pending...
      </div>
    );
  }

  if (judgeStatus === 'partial') {
    return (
      <div className="mt-4 text-sm text-[var(--text-secondary)]">
        ◐ Judge evaluation in progress...
      </div>
    );
  }

  if (!verdicts || verdicts.length === 0) return null;

  const successfulVerdicts = verdicts.filter((v) => !v.error);
  const blockingCount = blockingFlags
    ? Object.values(blockingFlags).filter(Boolean).length
    : 0;

  return (
    <div className="mt-4 border-t border-[var(--border)] pt-4">
      <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Judge Evaluation</h3>

      {/* Composite breakdown */}
      <div className="mb-3 space-y-1 text-sm">
        <div className="text-[var(--text-primary)]">
          Composite Score:{' '}
          <strong>{compositeScore !== null ? compositeScore.toFixed(1) : '—'}</strong> / 100
        </div>
        <div className="pl-2 text-[var(--text-muted)]">
          Test: {testScore.toFixed(1)} &times; {weights.test} ={' '}
          {(testScore * weights.test).toFixed(1)}
        </div>
        {blockingCount > 0 && (
          <div className="pl-2 text-[var(--score-fail)]">
            {blockingCount} blocking flag{blockingCount > 1 ? 's' : ''} (cap applied)
          </div>
        )}
      </div>

      {/* Criteria table */}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th className="py-1 text-left text-[var(--text-secondary)]">Criterion</th>
            <th className="py-1 text-center text-[var(--text-secondary)]">Med</th>
            {successfulVerdicts.map((v, i) => (
              <th key={i} className="py-1 text-center text-[var(--text-secondary)]">
                J{i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CRITERIA.map((c) => {
            const scores = successfulVerdicts.map((v) => v.scores[c.key]?.score ?? 0);
            const sorted = [...scores].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            const med =
              sorted.length % 2 === 0
                ? (sorted[mid - 1] + sorted[mid]) / 2
                : sorted[mid];

            return (
              <tr key={c.key} className="border-b border-[var(--border)]">
                <td className="py-1 text-[var(--text-primary)]">{c.title}</td>
                <td className="py-1 text-center font-medium text-[var(--text-primary)]">
                  {med}
                </td>
                {successfulVerdicts.map((v, i) => (
                  <td key={i} className="py-1 text-center text-[var(--text-muted)]">
                    {v.scores[c.key]?.score ?? '—'}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Blocking flags */}
      <div className="mt-3">
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Blocking Flags
        </h4>
        {BLOCKING_CHECKS.map((b) => {
          const triggered = blockingFlags?.[b.key] ?? false;
          const votes = successfulVerdicts.map((v) => v.blocking[b.key]?.triggered ?? false);
          const trueCount = votes.filter(Boolean).length;
          return (
            <div key={b.key} className="flex items-center gap-2 text-sm">
              <span className={triggered ? 'text-[var(--score-fail)]' : 'text-[var(--text-muted)]'}>
                {triggered ? '⚠' : '✗'}
              </span>
              <span className={triggered ? 'text-[var(--score-fail)]' : 'text-[var(--text-secondary)]'}>
                {b.title}
              </span>
              <span className="text-[var(--text-muted)]">
                {trueCount}/{successfulVerdicts.length}
              </span>
            </div>
          );
        })}
      </div>

      {/* Expandable rationale */}
      <button
        className="mt-2 text-sm text-[var(--accent)] hover:underline"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? '▾ Hide rationale' : '▸ Show rationale'}
      </button>
      {expanded && (
        <div className="mt-2 space-y-4 text-sm">
          {successfulVerdicts.map((v, i) => (
            <div key={i} className="rounded border border-[var(--border)] p-3">
              <h5 className="mb-1 font-medium text-[var(--text-primary)]">
                Judge {i + 1}: {v.providerName}
              </h5>
              {CRITERIA.map((c) => (
                <div key={c.key} className="mt-1 text-[var(--text-secondary)]">
                  <span className="font-medium text-[var(--text-primary)]">
                    {c.title} ({v.scores[c.key]?.score ?? '—'}):
                  </span>{' '}
                  {v.scores[c.key]?.rationale}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
