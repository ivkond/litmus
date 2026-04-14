'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { parsePrefillParams } from './prefill';
import { AgentCard } from '@/components/matrix-builder/agent-card';
import { ScenarioList } from '@/components/matrix-builder/scenario-list';
import { SummaryBar } from '@/components/matrix-builder/summary-bar';

interface ModelChip {
  dbId: string;
  name: string;
  provider?: string;
}

interface Agent {
  id: string;
  name: string;
  availableModels: ModelChip[];
}

interface Scenario {
  id: string;
  slug: string;
  name: string;
  language: string | null;
}

export function RunBuilder() {
  const router = useRouter();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingScenarios, setLoadingScenarios] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // selections: agentId → Set<modelDbId>
  const [selections, setSelections] = useState<Map<string, Set<string>>>(new Map());
  const [selectedScenarios, setSelectedScenarios] = useState<Set<string>>(new Set());

  const [refreshingAgents, setRefreshingAgents] = useState<Set<string>>(new Set());
  const [isStarting, setIsStarting] = useState(false);
  const searchParams = useSearchParams();

  // ── Data fetching ─────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then((data: Agent[]) => {
        // Normalise availableModels: DB stores it as JSON, may be null
        const normalised = data.map((a) => ({
          ...a,
          availableModels: Array.isArray(a.availableModels) ? a.availableModels : [],
        }));
        setAgents(normalised);
      })
      .catch(() => setError('Failed to load agents'))
      .finally(() => setLoadingAgents(false));
  }, []);

  useEffect(() => {
    fetch('/api/scenarios')
      .then((r) => r.json())
      .then((data: Scenario[]) => setScenarios(data))
      .catch(() => setError('Failed to load scenarios'))
      .finally(() => setLoadingScenarios(false));
  }, []);

  // ── Prefill from URL params ───────────────────────────────────
  // Re-applies when searchParams actually change (e.g. new navigation from
  // compare view), but NOT on re-renders with the same params.

  const appliedParamsRef = useRef<string>('');

  useEffect(() => {
    if (loadingAgents || loadingScenarios) return;

    const paramsKey = searchParams.toString();
    if (paramsKey === appliedParamsRef.current) return;
    appliedParamsRef.current = paramsKey;

    const prefill = parsePrefillParams({
      agents: searchParams.get('agents'),
      models: searchParams.get('models'),
      scenarios: searchParams.get('scenarios'),
    });

    const hasPrefill =
      prefill.agentIds.length > 0 ||
      prefill.modelIds.length > 0 ||
      prefill.scenarioIds.length > 0;

    if (!hasPrefill) {
      // Empty/no params → reset to default empty state (e.g. /run?agents=... → /run)
      setSelections(new Map());
      setSelectedScenarios(new Set());
      return;
    }

    // Preselect models grouped by their owning agent
    const prefillAgentIds = new Set(prefill.agentIds);
    const prefillModelIds = new Set(prefill.modelIds);
    const newSelections = new Map<string, Set<string>>();

    for (const agent of agents) {
      if (!prefillAgentIds.has(agent.id)) continue;
      const agentModels = new Set<string>();
      for (const model of agent.availableModels) {
        if (prefillModelIds.has(model.dbId)) {
          agentModels.add(model.dbId);
        }
      }
      if (agentModels.size > 0) {
        newSelections.set(agent.id, agentModels);
      }
    }

    if (newSelections.size > 0) {
      setSelections(newSelections);
    }

    // Preselect scenarios — silently drop unknown IDs
    const validScenarioIds = new Set(scenarios.map((s) => s.id));
    const prefillScenarios = new Set(
      prefill.scenarioIds.filter((id) => validScenarioIds.has(id))
    );
    if (prefillScenarios.size > 0) {
      setSelectedScenarios(prefillScenarios);
    }
  }, [loadingAgents, loadingScenarios, agents, scenarios, searchParams]);

  // ── Selection handlers ────────────────────────────────────────

  const handleToggleModel = useCallback((agentId: string, modelDbId: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(agentId) ?? []);
      if (current.has(modelDbId)) {
        current.delete(modelDbId);
      } else {
        current.add(modelDbId);
      }
      next.set(agentId, current);
      return next;
    });
  }, []);

  const handleToggleScenario = useCallback((id: string) => {
    setSelectedScenarios((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAllScenarios = useCallback(() => {
    setSelectedScenarios((prev) => {
      const allSelected = scenarios.length > 0 && scenarios.every((s) => prev.has(s.id));
      if (allSelected) {
        return new Set();
      }
      return new Set(scenarios.map((s) => s.id));
    });
  }, [scenarios]);

  // ── Refresh models for a single agent ────────────────────────

  const handleRefreshModels = useCallback(async (agentId: string) => {
    setRefreshingAgents((prev) => new Set(prev).add(agentId));
    try {
      const res = await fetch(`/api/agents/${agentId}/models`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Failed to refresh models');
        return;
      }
      const refreshed: ModelChip[] = await res.json();
      setAgents((prev) =>
        prev.map((a) =>
          a.id === agentId ? { ...a, availableModels: refreshed } : a,
        ),
      );
    } catch {
      setError('Failed to refresh models');
    } finally {
      setRefreshingAgents((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }, []);

  // ── Start Run ─────────────────────────────────────────────────

  const handleStartRun = useCallback(async () => {
    setIsStarting(true);
    setError(null);
    try {
      const agentPayload = Array.from(selections.entries())
        .map(([id, modelSet]) => ({ id, models: Array.from(modelSet) }))
        .filter((a) => a.models.length > 0);

      const body = {
        agents: agentPayload,
        scenarios: Array.from(selectedScenarios),
      };

      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(errBody.error ?? `Server error ${res.status}`);
        return;
      }

      const { runId } = await res.json();
      router.push(`/run/${runId}`);
    } catch {
      setError('Failed to start run');
    } finally {
      setIsStarting(false);
    }
  }, [selections, selectedScenarios, router]);

  // ── Derived values ────────────────────────────────────────────

  const laneCount = Array.from(selections.values()).reduce(
    (sum, modelSet) => sum + modelSet.size,
    0,
  );

  const isLoading = loadingAgents || loadingScenarios;

  // ── Render ────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="font-mono text-lg text-[var(--text-primary)]">New Benchmark Run</h1>
        <p className="text-sm text-[var(--text-muted)]">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="font-mono text-lg text-[var(--text-primary)]">New Benchmark Run</h1>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400 font-mono">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Agents */}
        <section className="space-y-4">
          <h2 className="font-mono text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            Agents &amp; Models
          </h2>
          {agents.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">No agents registered.</p>
          ) : (
            agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selectedModels={selections.get(agent.id) ?? new Set()}
                onToggleModel={handleToggleModel}
                onRefreshModels={handleRefreshModels}
                isRefreshing={refreshingAgents.has(agent.id)}
              />
            ))
          )}
        </section>

        {/* Right: Scenarios */}
        <section className="space-y-4">
          <h2 className="font-mono text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            Scenarios
          </h2>
          {scenarios.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">No scenarios imported.</p>
          ) : (
            <ScenarioList
              scenarios={scenarios}
              selected={selectedScenarios}
              onToggle={handleToggleScenario}
              onSelectAll={handleSelectAllScenarios}
            />
          )}
        </section>
      </div>

      <SummaryBar
        laneCount={laneCount}
        scenarioCount={selectedScenarios.size}
        onStart={handleStartRun}
        isStarting={isStarting}
      />
    </div>
  );
}
