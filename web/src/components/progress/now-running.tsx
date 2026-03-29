'use client';

interface NowRunningProps { agent: string; model: string; scenario: string; elapsed: number }

export function NowRunning({ agent, model, scenario, elapsed }: NowRunningProps) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      <span className="font-mono text-[var(--text-secondary)]">{agent} × {model} × {scenario}</span>
      <span className="text-xs text-[var(--text-muted)]">({elapsed}s)</span>
    </div>
  );
}
