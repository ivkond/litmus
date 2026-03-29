'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DrillDownResponse } from '@/lib/compare/types';
import { JudgeEvaluation } from '@/components/compare/judge-evaluation';

interface Props {
  scenarioId: string;
  agentId: string;
  modelId: string;
  onClose: () => void;
}

export function DrillDownPanel({ scenarioId, agentId, modelId, onClose }: Props) {
  const [data, setData] = useState<DrillDownResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reEvalLoading, setReEvalLoading] = useState(false);
  const [recalcLoading, setRecalcLoading] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ agentId, modelId });

    fetch(`/api/compare/${scenarioId}/drill-down?${params.toString()}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json() as Promise<DrillDownResponse>;
      })
      .then((result) => {
        setData(result);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [scenarioId, agentId, modelId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleReEvaluate() {
    if (!data?.latest?.runResultId) return;
    setReEvalLoading(true);
    try {
      const res = await fetch('/api/judge/re-evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runResultId: data.latest.runResultId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error('[DrillDownPanel] Re-evaluate failed:', body);
      }
      fetchData();
    } catch (err) {
      console.error('[DrillDownPanel] Re-evaluate error:', err);
    } finally {
      setReEvalLoading(false);
    }
  }

  async function handleRecalculate() {
    if (!data?.latest?.runResultId) return;
    setRecalcLoading(true);
    try {
      await fetch('/api/judge/recalculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runResultId: data.latest.runResultId }),
      });
      fetchData();
    } catch (err) {
      console.error('[DrillDownPanel] Recalculate error:', err);
    } finally {
      setRecalcLoading(false);
    }
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-drilldown-title"
        className="fixed right-0 top-0 bottom-0 z-50 w-[480px] max-w-full overflow-y-auto border-l border-[var(--border)] bg-[var(--bg-overlay)] shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] p-4">
          <h3 id="compare-drilldown-title" className="font-mono text-sm font-semibold text-[var(--text-primary)]">
            {data ? data.scenario.name : 'Loading'}
          </h3>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="text-lg text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            x
          </button>
        </div>
        <div className="p-4">
          {loading && <div className="text-sm text-[var(--text-muted)]">Loading...</div>}
          {error && <div className="text-sm text-[var(--score-fail)]">Failed to load details: {error}</div>}
          {data && (
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-xs uppercase tracking-wider text-[var(--text-muted)]">
                  {data.agent.name} x {data.model.name}
                </div>
                {data.latest ? (
                  <>
                    <div className="space-y-2 rounded-md bg-[var(--bg-raised)] p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-2xl font-bold text-[var(--text-primary)]">
                          {data.latest.score.toFixed(0)}%
                        </span>
                        <span className="rounded px-2 py-0.5 text-xs font-semibold text-[var(--text-primary)]">
                          {data.latest.status}
                        </span>
                      </div>
                      <div className="text-xs text-[var(--text-secondary)]">
                        Tests: {data.latest.testsPassed}/{data.latest.testsTotal}
                        {' | '}
                        Attempt {data.latest.attempt}/{data.latest.maxAttempts}
                        {' | '}
                        {data.latest.durationSeconds}s
                      </div>
                    </div>
                    {data.latest.judgeStatus && (
                      <JudgeEvaluation
                        judgeStatus={data.latest.judgeStatus}
                        compositeScore={data.latest.compositeScore}
                        testScore={data.latest.score}
                        blockingFlags={data.latest.blockingFlags}
                        verdicts={data.latest.judgeVerdicts}
                        weights={{ test: 0.4, judge: 0.6 }}
                      />
                    )}
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={handleReEvaluate}
                        disabled={reEvalLoading || recalcLoading}
                        className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                      >
                        {reEvalLoading ? 'Re-evaluating…' : 'Re-evaluate'}
                      </button>
                      {data.latest.judgeStatus === 'completed' && (
                        <button
                          onClick={handleRecalculate}
                          disabled={reEvalLoading || recalcLoading}
                          className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                        >
                          {recalcLoading ? 'Recalculating…' : 'Recalculate Score'}
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-[var(--score-fail)]">
                    No successful result - all attempts errored.
                  </div>
                )}
              </div>
              <div>
                <div className="mb-2 text-xs uppercase tracking-wider text-[var(--text-muted)]">Run History</div>
                <div className="space-y-1">
                  {data.history.map((entry, index) => (
                    <div
                      key={`${entry.runId}-${index}`}
                      className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs ${
                        entry.isLatest ? 'bg-[var(--accent-dim)]' : ''
                      }`}
                    >
                      <span className="w-14 font-mono font-semibold">
                        {entry.status === 'error' ? 'ERROR' : `${entry.score.toFixed(0)}%`}
                      </span>
                      <span className="flex-1 truncate text-[var(--text-muted)]">
                        {entry.status === 'error'
                          ? entry.errorMessage
                          : `${entry.testsPassed}/${entry.testsTotal} tests`}
                      </span>
                      {entry.trend !== null && entry.trend !== 0 && (
                        <span className="font-mono text-[0.65rem]">
                          {entry.trend > 0 ? '+' : ''}
                          {entry.trend.toFixed(0)}%
                        </span>
                      )}
                      {entry.isLatest && (
                        <span className="text-[0.6rem] font-semibold text-[var(--accent)]">CURRENT</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
