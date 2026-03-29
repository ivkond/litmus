'use client';

import type { LeaderboardEntry } from '@/lib/compare/types';

interface Props {
  entries: LeaderboardEntry[];
}

export function Leaderboard({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-[var(--text-muted)]">
        No ranked data yet.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map((entry) => {
        const isLeader = entry.rank === 1;
        const isErrorsOnly = entry.scenarioCount === 0 && entry.avgScore === 0;

        return (
          <div
            key={entry.entityId}
            className={`rounded-md px-3 py-2 ${isLeader ? 'bg-[var(--accent-dim)]' : 'hover:bg-[var(--bg-hover)]'}`}
          >
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-semibold text-[var(--text-primary)]">
                  {isLeader && <span className="mr-1">🥇</span>}
                  #{entry.rank} {entry.entityName}
                </div>
                <div className="text-[0.65rem] text-[var(--text-muted)]">
                  scenarios {entry.scenarioCount}/{entry.totalScenarios}
                  {' | '}
                  counterparts {entry.counterpartCount}
                  {entry.judgedTotal != null && entry.judgedTotal > 0 && (
                    <>
                      {' | '}
                      judged {entry.judgedCount}/{entry.judgedTotal}
                    </>
                  )}
                </div>
              </div>
              <div className="text-right">
                {isErrorsOnly ? (
                  <div className="text-[0.6rem] uppercase tracking-wider text-[var(--score-fail)]">
                    errors only
                  </div>
                ) : (
                  <div className="font-mono text-sm font-bold text-[var(--text-primary)]">
                    {entry.avgScore.toFixed(0)}%
                  </div>
                )}
                {entry.lowCoverage && (
                  <div className="text-[0.6rem] uppercase tracking-wider text-[var(--score-poor)]">
                    low coverage
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
