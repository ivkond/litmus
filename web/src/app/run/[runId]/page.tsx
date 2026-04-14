'use client';

import { useEffect, useRef, useState } from 'react';
import { use } from 'react';
import { ProgressBar } from '@/components/progress/progress-bar';
import { NowRunning } from '@/components/progress/now-running';
import { ProgressMatrix, cellKey, type CellData, type CellStatus } from '@/components/progress/progress-matrix';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'error' | 'cancelled';

interface RunMeta {
  id: string;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
}

interface NowState {
  agent: string;
  model: string;
  scenario: string;
  startTime: number;
}

function StatusBadge({ status }: { status: RunStatus }) {
  if (status === 'pending') {
    return (
      <Badge variant="default">pending</Badge>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md font-mono text-xs font-medium bg-[var(--score-mid-bg)] text-amber-400">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        running
      </span>
    );
  }
  if (status === 'completed') {
    return <Badge variant="success">completed</Badge>;
  }
  if (status === 'failed') {
    return <Badge variant="error">failed</Badge>;
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md font-mono text-xs font-medium border border-[var(--score-fail)] text-[var(--score-fail)]">
        error
      </span>
    );
  }
  if (status === 'cancelled') {
    return (
      <Badge variant="default">
        <span className="mr-1">/</span>cancelled
      </Badge>
    );
  }
  return null;
}

export default function RunProgressPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);

  const [runMeta, setRunMeta] = useState<RunMeta | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>('pending');
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [startedAt, setStartedAt] = useState<number>(() => Date.now());
  const [now, setNow] = useState<NowState | null>(null);
  const [nowElapsed, setNowElapsed] = useState(0);

  // Matrix state
  const [rows, setRows] = useState<Array<{ agent: string; model: string }>>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [cells, setCells] = useState<Map<string, CellData>>(new Map());

  const rowsRef = useRef<Array<{ agent: string; model: string }>>([]);
  const columnsRef = useRef<string[]>([]);
  const cellsRef = useRef<Map<string, CellData>>(new Map());
  const nowRef = useRef<NowState | null>(null);
  const hydratedRef = useRef(false);
  /** Cell keys that were already terminal when hydrated from GET — prevents SSE double-count */
  const hydratedTerminalKeysRef = useRef<Set<string>>(new Set());

  // Sync refs with state so SSE handler always has fresh values
  rowsRef.current = rows;
  columnsRef.current = columns;
  nowRef.current = now;

  // Tick elapsed seconds for "now running"
  useEffect(() => {
    const id = setInterval(() => {
      if (nowRef.current) {
        setNowElapsed(Math.round((Date.now() - nowRef.current.startTime) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Ensure a row exists for agent×model pair
  function ensureRow(agent: string, model: string) {
    const existing = rowsRef.current.find((r) => r.agent === agent && r.model === model);
    if (!existing) {
      const next = [...rowsRef.current, { agent, model }];
      rowsRef.current = next;
      setRows(next);
    }
  }

  // Ensure a column exists for scenario
  function ensureColumn(scenario: string) {
    if (!columnsRef.current.includes(scenario)) {
      const next = [...columnsRef.current, scenario];
      columnsRef.current = next;
      setColumns(next);
    }
  }

  function updateCell(agent: string, model: string, scenario: string, data: CellData) {
    ensureRow(agent, model);
    ensureColumn(scenario);
    const key = cellKey(agent, model, scenario);
    const next = new Map(cellsRef.current);
    next.set(key, data);
    cellsRef.current = next;
    setCells(next);
  }

  // Fetch initial run metadata + hydrate matrix from existing tasks/results
  useEffect(() => {
    interface TaskRow {
      id: string;
      status: string;
      agentName: string;
      modelName: string;
      scenarioSlug: string;
    }
    interface ResultRow {
      agentName: string;
      modelName: string;
      scenarioSlug: string;
      status: string;
      totalScore: number;
      attempt: number;
      maxAttempts: number;
    }
    interface RunResponse extends RunMeta {
      tasks?: TaskRow[];
      results?: ResultRow[];
    }

    fetch(`/api/runs/${runId}`)
      .then((r) => r.json())
      .then((data: RunResponse) => {
        setRunMeta(data);
        setRunStatus(data.status as RunStatus);
        if (data.startedAt) {
          setStartedAt(new Date(data.startedAt).getTime());
        }

        // Hydrate matrix from persisted tasks
        if (data.tasks && data.tasks.length > 0) {
          let hydratedTotal = 0;
          let hydratedCompleted = 0;

          // Build a lookup: "agent|model|scenario" → score (from results, now with names)
          const scoreMap = new Map<string, number>();
          if (data.results) {
            for (const r of data.results) {
              const key = `${r.agentName}|${r.modelName}|${r.scenarioSlug}`;
              scoreMap.set(key, r.totalScore);
            }
          }

          const terminalKeys = new Set<string>();

          for (const task of data.tasks) {
            hydratedTotal++;
            const status = task.status as string;
            const terminalStatuses = ['completed', 'failed', 'error', 'cancelled'];
            if (terminalStatuses.includes(status)) {
              hydratedCompleted++;
              terminalKeys.add(cellKey(task.agentName, task.modelName, task.scenarioSlug));
            }

            const cellStatus = (['completed', 'failed', 'error', 'cancelled', 'running'].includes(status)
              ? status
              : 'pending') as CellStatus;

            const scoreKey = `${task.agentName}|${task.modelName}|${task.scenarioSlug}`;
            const score = scoreMap.get(scoreKey);

            updateCell(task.agentName, task.modelName, task.scenarioSlug, {
              status: cellStatus,
              ...(score !== undefined ? { score } : {}),
            });
          }

          hydratedTerminalKeysRef.current = terminalKeys;

          setTotal(hydratedTotal);
          setCompleted(hydratedCompleted);
          hydratedRef.current = true;
        }
      })
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- updateCell uses refs, stable across renders
  }, [runId]);

  // Connect to SSE stream
  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/stream`);

    es.onmessage = (e: MessageEvent) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(e.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = event.type as string;
      const agent = event.agent as string | undefined;
      const model = event.model as string | undefined;
      const scenario = event.scenario as string | undefined;

      switch (type) {
        case 'task:started': {
          if (!agent || !model || !scenario) break;
          updateCell(agent, model, scenario, { status: 'running' as CellStatus });
          const attempt = event.attempt as number | undefined;
          // Only increment total from SSE if we didn't hydrate from GET
          if (attempt === 1 && !hydratedRef.current) {
            setTotal((t) => t + 1);
          }
          setNow({ agent, model, scenario, startTime: Date.now() });
          setNowElapsed(0);
          break;
        }

        case 'task:retrying': {
          if (!agent || !model || !scenario) break;
          const attempt = event.attempt as number | undefined;
          const maxAttempts = event.maxAttempts as number | undefined;
          updateCell(agent, model, scenario, {
            status: 'retrying' as CellStatus,
            attempt: attempt,
            maxAttempts: maxAttempts,
          });
          setNow({ agent, model, scenario, startTime: Date.now() });
          setNowElapsed(0);
          break;
        }

        case 'task:completed': {
          if (!agent || !model || !scenario) break;
          const score = event.score as number | undefined;
          updateCell(agent, model, scenario, {
            status: 'completed' as CellStatus,
            score: score,
          });
          // Only increment if this wasn't already counted during hydration
          const ckCompleted = cellKey(agent, model, scenario);
          if (hydratedTerminalKeysRef.current.has(ckCompleted)) {
            hydratedTerminalKeysRef.current.delete(ckCompleted);
          } else {
            setCompleted((c) => c + 1);
          }
          if (nowRef.current?.agent === agent && nowRef.current?.model === model && nowRef.current?.scenario === scenario) {
            setNow(null);
          }
          break;
        }

        case 'task:failed': {
          if (!agent || !model || !scenario) break;
          const score = event.score as number | undefined;
          updateCell(agent, model, scenario, {
            status: 'failed' as CellStatus,
            score: score,
          });
          const ckFailed = cellKey(agent, model, scenario);
          if (hydratedTerminalKeysRef.current.has(ckFailed)) {
            hydratedTerminalKeysRef.current.delete(ckFailed);
          } else {
            setCompleted((c) => c + 1);
          }
          if (nowRef.current?.agent === agent && nowRef.current?.model === model && nowRef.current?.scenario === scenario) {
            setNow(null);
          }
          break;
        }

        case 'task:error': {
          if (!agent || !model || !scenario) break;
          updateCell(agent, model, scenario, { status: 'error' as CellStatus });
          const ckError = cellKey(agent, model, scenario);
          if (hydratedTerminalKeysRef.current.has(ckError)) {
            hydratedTerminalKeysRef.current.delete(ckError);
          } else {
            setCompleted((c) => c + 1);
          }
          if (nowRef.current?.agent === agent && nowRef.current?.model === model && nowRef.current?.scenario === scenario) {
            setNow(null);
          }
          break;
        }

        case 'task:cancelled': {
          if (!agent || !model || !scenario) break;
          updateCell(agent, model, scenario, { status: 'cancelled' as CellStatus });
          if (nowRef.current?.agent === agent && nowRef.current?.model === model && nowRef.current?.scenario === scenario) {
            setNow(null);
          }
          break;
        }

        case 'run:completed':
          setRunStatus('completed');
          setNow(null);
          es.close();
          break;

        case 'run:cancelled':
          setRunStatus('cancelled');
          setNow(null);
          es.close();
          break;

        case 'run:error':
          setRunStatus('error');
          setNow(null);
          es.close();
          break;
      }
    };

    es.onerror = () => {
      es.close();
    };

    return () => {
      es.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- updateCell uses refs, stable across renders
  }, [runId]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-lg text-[var(--text-primary)]">Run Progress</h1>
          <p className="font-mono text-xs text-[var(--text-muted)] mt-0.5">{runId}</p>
        </div>
        <StatusBadge status={runStatus} />
      </div>

      {/* Progress bar */}
      <Card>
        <ProgressBar completed={completed} total={total} startedAt={startedAt} />
        {now && (
          <div className="mt-3 pt-3 border-t border-[var(--border)]">
            <NowRunning
              agent={now.agent}
              model={now.model}
              scenario={now.scenario}
              elapsed={nowElapsed}
            />
          </div>
        )}
      </Card>

      {/* Matrix */}
      <div>
        <h2 className="font-mono text-xs uppercase tracking-wider text-[var(--text-muted)] mb-3">
          Results Matrix
        </h2>
        <Card className="p-0">
          <div className="p-4">
            <ProgressMatrix rows={rows} columns={columns} cells={cells} />
          </div>
        </Card>
      </div>

      {/* Run not found */}
      {runMeta === null && (
        <p className="text-sm text-[var(--text-muted)]">Loading run…</p>
      )}
    </div>
  );
}
