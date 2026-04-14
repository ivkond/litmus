'use client';

import { useSyncExternalStore } from 'react';

interface ProgressBarProps {
  completed: number;
  total: number;
  startedAt: number; // timestamp ms
}

function useElapsedSeconds(startedAt: number): number {
  return useSyncExternalStore(
    (onStoreChange) => {
      const id = setInterval(onStoreChange, 1000);
      return () => clearInterval(id);
    },
    () => Math.round((Date.now() - startedAt) / 1000),
    () => 0,
  );
}

export function ProgressBar({ completed, total, startedAt }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const elapsed = useElapsedSeconds(startedAt);

  let eta: string | null = null;
  if (completed > 0 && completed < total) {
    const perTask = elapsed / completed;
    const remaining = Math.round(perTask * (total - completed));
    eta = remaining > 60 ? `~${Math.ceil(remaining / 60)}m remaining` : `~${remaining}s remaining`;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-mono text-[var(--text-secondary)]">{completed} / {total} tasks</span>
        {eta && <span className="text-xs text-[var(--text-muted)]">{eta}</span>}
      </div>
      <div className="h-2 rounded-full bg-[var(--bg-raised)] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--accent)] transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
