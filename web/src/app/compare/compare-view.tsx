'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CompareResponse } from '@/lib/compare/types';
import { AnchorDropdown } from '@/components/compare/anchor-dropdown';
import { BreakdownPopover } from '@/components/compare/breakdown-popover';
import { DrillDownPanel } from '@/components/compare/drill-down-panel';
import { Heatmap } from '@/components/compare/heatmap';
import { Leaderboard } from '@/components/compare/leaderboard';
import { TabBar } from '@/components/compare/tab-bar';

const MAX_URL_BYTES = 6144;

export function buildPrefillUrl(participants: {
  agentIds: string[];
  modelIds: string[];
  scenarioIds: string[];
}): string {
  const parts: Array<{ key: string; ids: string[] }> = [
    { key: 'agents', ids: participants.agentIds },
    { key: 'models', ids: participants.modelIds },
    { key: 'scenarios', ids: participants.scenarioIds },
  ];

  // Manual query string: URLSearchParams encodes commas as %2C (3 bytes
  // vs 1), inflating URL length and distorting the 6KB truncation threshold.
  // searchParams.get() would decode them back, but the longer encoded URL
  // defeats the byte-based safety check. UUIDs are safe for raw join.
  function buildUrl(paramParts: Array<{ key: string; ids: string[] }>): string {
    const params = paramParts
      .filter((p) => p.ids.length > 0)
      .map((p) => `${p.key}=${p.ids.join(',')}`)
      .join('&');
    return params ? `/run?${params}` : '/run';
  }

  let url = buildUrl(parts);
  let byteLength = new TextEncoder().encode(url).length;

  if (byteLength <= MAX_URL_BYTES) {
    return url;
  }

  // Progressive truncation: only drop scenarios to preserve agent×model compatibility.
  const scenarioPart = parts[2]; // 'scenarios'
  const originalCount = scenarioPart.ids.length;

  while (scenarioPart.ids.length > 1) {
    scenarioPart.ids = scenarioPart.ids.slice(0, scenarioPart.ids.length - 1);
    url = buildUrl(parts);
    byteLength = new TextEncoder().encode(url).length;
    if (byteLength <= MAX_URL_BYTES) {
      console.warn(
        `[buildPrefillUrl] Truncated scenarios from ${originalCount} to ${scenarioPart.ids.length} to fit URL limit`
      );
      return url;
    }
  }

  // If still too long after truncating scenarios to 1, return as-is
  console.warn('[buildPrefillUrl] URL still exceeds limit after truncating scenarios to 1');
  return url;
}

interface Props {
  data: CompareResponse;
}

interface DrillDownState {
  scenarioId: string;
  agentId: string;
  modelId: string;
}

interface BreakdownState {
  scenarioId: string;
  entityId: string;
  anchorEl: HTMLElement | null;
}

export function CompareView({ data }: Props) {
  const router = useRouter();
  const [drillDown, setDrillDown] = useState<DrillDownState | null>(null);
  const [breakdown, setBreakdown] = useState<BreakdownState | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/compare/stream');

    es.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data as string) as { type: string };
        if (parsed.type === 'judge:started' || parsed.type === 'judge:verdict' || parsed.type === 'judge:completed') {
          router.refresh();
        }
      } catch {
        // ignore malformed events
      }
    };

    return () => {
      es.close();
    };
  }, [router]);

  const isDetailedLens = data.lens === 'agent-x-models' || data.lens === 'model-x-agents';

  const handleCellClick = useCallback((entityId: string, scenarioId: string) => {
    if (isDetailedLens) {
      const agentId = data.lens === 'agent-x-models' ? data.anchor!.id : entityId;
      const modelId = data.lens === 'model-x-agents' ? data.anchor!.id : entityId;
      setDrillDown({ scenarioId, agentId, modelId });
      return;
    }

    const anchorEl = document.querySelector(`[data-cell="${entityId}:${scenarioId}"]`) as HTMLElement | null;
    setBreakdown({ scenarioId, entityId, anchorEl });
  }, [data.anchor, data.lens, isDetailedLens]);

  async function handleAction(
    action: 'reEvaluatePending' | 'reEvaluateAll' | 'reEvaluateScenario' | 'recalculate',
    scenarioId?: string
  ) {
    setActionLoading(action);
    setActionsOpen(false);
    try {
      switch (action) {
        case 'reEvaluatePending':
          await fetch('/api/judge/re-evaluate-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'pending' }),
          });
          break;
        case 'reEvaluateAll':
          await fetch('/api/judge/re-evaluate-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'all' }),
          });
          break;
        case 'reEvaluateScenario':
          if (scenarioId) {
            await fetch('/api/judge/re-evaluate-bulk', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'all', scenarioId }),
            });
          }
          break;
        case 'recalculate':
          await fetch('/api/judge/recalculate', { method: 'POST' });
          break;
      }
      router.refresh();
    } catch (err) {
      console.error('[CompareView] Action failed:', err);
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-lg text-[var(--text-primary)]">Compare</h1>

        <div className="flex items-center gap-3">
          {/* "Run more tests" link — visible when compare has results */}
          {data.leaderboard.length > 0 && (
            <Link
              href={buildPrefillUrl(data.participants)}
              className="font-mono text-xs text-[var(--accent)] hover:underline"
            >
              + Run more tests
            </Link>
          )}

          {/* Actions dropdown — judge control */}
          <div className="relative">
          <button
            onClick={() => setActionsOpen(!actionsOpen)}
            disabled={actionLoading !== null}
            className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {actionLoading ? 'Running…' : 'Actions ▾'}
          </button>
          {actionsOpen && (
            <div className="absolute right-0 z-10 mt-1 w-56 rounded border border-[var(--border)] bg-[var(--bg-raised)] py-1 shadow-lg">
              <button
                onClick={() => handleAction('reEvaluatePending')}
                className="block w-full px-4 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                Re-evaluate pending
              </button>
              <button
                onClick={() => handleAction('reEvaluateAll')}
                className="block w-full px-4 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                Re-evaluate all
              </button>
              {data.heatmap.rows.length > 0 && (
                <>
                  <hr className="my-1 border-[var(--border)]" />
                  <div className="px-4 py-1 text-[0.65rem] uppercase tracking-wider text-[var(--text-muted)]">
                    Re-evaluate scenario
                  </div>
                  {data.heatmap.columns.map((scenario) => (
                    <button
                      key={scenario.id}
                      onClick={() => handleAction('reEvaluateScenario', scenario.id)}
                      className="block w-full px-4 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    >
                      {scenario.name}
                    </button>
                  ))}
                </>
              )}
              <hr className="my-1 border-[var(--border)]" />
              <button
                onClick={() => handleAction('recalculate')}
                className="block w-full px-4 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                Recalculate scores
              </button>
            </div>
          )}
          </div>
        </div>
      </div>

      <TabBar activeLens={data.lens} />

      {isDetailedLens && data.availableAnchors && (
        <AnchorDropdown
          lens={data.lens}
          anchors={data.availableAnchors}
          selectedId={data.anchor?.id}
        />
      )}

      <div className="flex gap-4">
        <div className="max-h-[70vh] w-[280px] flex-shrink-0 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-2">
          <Leaderboard entries={data.leaderboard} />
        </div>
        <div className="flex-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-2">
          <Heatmap data={data} onCellClick={handleCellClick} />
        </div>
      </div>

      {drillDown && (
        <DrillDownPanel
          key={`${drillDown.scenarioId}:${drillDown.agentId}:${drillDown.modelId}`}
          scenarioId={drillDown.scenarioId}
          agentId={drillDown.agentId}
          modelId={drillDown.modelId}
          onClose={() => setDrillDown(null)}
        />
      )}

      {breakdown && (
        <BreakdownPopover
          key={`${breakdown.scenarioId}:${breakdown.entityId}:${data.lens}`}
          scenarioId={breakdown.scenarioId}
          entityId={breakdown.entityId}
          lens={data.lens}
          anchorEl={breakdown.anchorEl}
          onClose={() => setBreakdown(null)}
        />
      )}
    </div>
  );
}
