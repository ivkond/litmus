'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BreakdownResponse, LensType } from '@/lib/compare/types';

interface Props {
  scenarioId: string;
  entityId: string;
  lens: LensType;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

export function BreakdownPopover({ scenarioId, entityId, lens, anchorEl, onClose }: Props) {
  const [data, setData] = useState<BreakdownResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const paramKey = lens === 'model-ranking' ? 'modelId' : 'agentId';

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      [paramKey]: entityId,
    });

    fetch(`/api/compare/${scenarioId}/breakdown?${params.toString()}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json() as Promise<BreakdownResponse>;
      })
      .then((result) => {
        if (!cancelled) {
          setData(result);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [scenarioId, entityId, paramKey]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const rect = anchorEl?.getBoundingClientRect();
  const width = 288;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768;
  const style = rect
    ? {
        top: Math.min(viewportHeight - 16, rect.bottom + 4),
        left: Math.min(Math.max(8, rect.left - 100), viewportWidth - width - 8),
        position: 'fixed' as const,
      }
    : {
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        position: 'fixed' as const,
      };

  const navigateLens = lens === 'model-ranking' ? 'agent-x-models' : 'model-x-agents';
  const navigateParam = lens === 'model-ranking' ? 'agentId' : 'modelId';

  return (
    <div
      role="dialog"
      aria-modal="false"
      ref={ref}
      className="z-50 w-72 rounded-lg border border-[var(--border)] bg-[var(--bg-overlay)] p-3 shadow-xl"
      style={style}
    >
      {loading && <div className="text-xs text-[var(--text-muted)]">Loading...</div>}
      {error && <div className="text-xs text-[var(--score-fail)]">Failed: {error}</div>}
      {data && (
        <>
          <div className="mb-2 text-xs text-[var(--text-muted)]">
            {data.entity.name} on {data.scenario.name}
            {data.avgScore !== null && (
              <span className="float-right font-mono font-bold text-[var(--text-primary)]">
                avg {data.avgScore.toFixed(0)}%
              </span>
            )}
          </div>
          <div className="space-y-1">
            {data.breakdown.map((entry) => (
              <button
                key={entry.counterpartId}
                onClick={() => router.push(`/compare?lens=${navigateLens}&${navigateParam}=${entry.counterpartId}`)}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-xs transition-colors hover:bg-[var(--bg-hover)]"
              >
                <span className="text-[var(--text-primary)]">{entry.counterpartName}</span>
                <span className="font-mono font-semibold">
                  {entry.score.toFixed(0)}%
                  {entry.stale && <span className="ml-1 text-[var(--text-muted)]">!</span>}
                </span>
              </button>
            ))}
            {data.errorOnlyCounterparts.map((entry) => (
              <div
                key={entry.counterpartId}
                className="flex items-center justify-between px-2 py-1 text-xs"
              >
                <span className="text-[var(--text-muted)]">{entry.counterpartName}</span>
                <span className="font-mono text-[var(--score-fail)]">x {entry.errorCount} errors</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
