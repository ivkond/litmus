'use client';

interface SummaryBarProps {
  laneCount: number;     // number of (agent × model) pairs selected
  scenarioCount: number;
  onStart: () => void;
  isStarting: boolean;
}

export function SummaryBar({ laneCount, scenarioCount, onStart, isStarting }: SummaryBarProps) {
  // Each lane runs every scenario → total tasks = lanes × scenarios
  const totalTasks = laneCount * scenarioCount;

  return (
    <div className="flex items-center justify-between p-4 rounded-lg bg-[var(--bg-raised)] border border-[var(--border)]">
      <div className="font-mono text-sm text-[var(--text-secondary)]">
        <span className="text-[var(--accent)]">{laneCount}</span> lane{laneCount !== 1 ? 's' : ''}
        {' × '}
        <span className="text-[var(--accent)]">{scenarioCount}</span> scenario{scenarioCount !== 1 ? 's' : ''}
        {' = '}
        <span className="font-bold text-[var(--text-primary)]">{totalTasks}</span> task{totalTasks !== 1 ? 's' : ''}
      </div>
      <button
        onClick={onStart}
        disabled={totalTasks === 0 || isStarting}
        className="font-mono text-sm px-6 py-2 rounded-lg bg-[var(--accent)] text-[var(--bg-base)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isStarting ? 'Starting...' : 'Start Run'}
      </button>
    </div>
  );
}
