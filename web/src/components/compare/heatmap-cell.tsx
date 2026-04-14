'use client';

import type { HeatmapCell as HeatmapCellData } from '@/lib/compare/types';

interface Props {
  cell: HeatmapCellData | null;
  cellKey?: string;
  onClick?: () => void;
}

function scoreLevel(score: number): 'excellent' | 'good' | 'mid' | 'poor' | 'fail' {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'mid';
  if (score >= 30) return 'poor';
  return 'fail';
}

export function HeatmapCell({ cell, cellKey, onClick }: Props) {
  if (!cell) {
    return (
      <td
        data-cell={cellKey}
        className="px-2 py-1.5 text-center font-mono text-xs text-[var(--text-muted)]"
      >
        -
      </td>
    );
  }

  if (cell.errorOnly) {
    return (
      <td
        data-cell={cellKey}
        className="cursor-pointer px-2 py-1.5 text-center hover:opacity-80"
        onClick={onClick}
        title={`${cell.errorCount ?? 0} attempts failed - no successful result yet`}
      >
        <span className="font-bold text-[var(--score-fail)]">x</span>
      </td>
    );
  }

  const level = scoreLevel(cell.score);
  const borderStyle = cell.stale
    ? '2px dashed var(--text-muted)'
    : cell.bestInRow
      ? '2px solid var(--accent)'
      : 'none';

  const title = cell.stale
    ? cell.staleCount !== undefined
      ? `${cell.staleCount} of ${cell.sourceCount} source results may be outdated`
      : 'Latest run errored; showing previous result'
    : undefined;

  return (
    <td
      data-cell={cellKey}
      className="cursor-pointer px-2 py-1.5 text-center transition-opacity hover:opacity-80"
      style={{
        position: 'relative',
        backgroundColor: `var(--score-${level}-bg)`,
        color: `var(--score-${level})`,
        border: borderStyle,
      }}
      onClick={onClick}
      title={title}
    >
      {(cell.judgeStatus === 'pending' || cell.judgeStatus === 'partial') && (
        <span
          className="absolute right-0.5 top-0.5 text-[0.55rem] leading-none"
          title={cell.judgeStatus === 'pending' ? 'Judge evaluation pending' : 'Judge evaluation in progress'}
        >
          {cell.judgeStatus === 'pending' ? '⏳' : '◐'}
        </span>
      )}
      <span className="font-mono text-xs font-semibold">{cell.score.toFixed(0)}%</span>
      {cell.testsPassed !== undefined && cell.testsTotal !== undefined && (
        <div className="text-[0.6rem] opacity-70">
          {cell.testsPassed}/{cell.testsTotal}
        </div>
      )}
    </td>
  );
}
