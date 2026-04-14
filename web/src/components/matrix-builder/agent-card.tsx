'use client';

import { useCallback } from 'react';
import { ModelCombobox } from './model-combobox';

interface ModelChip {
  dbId: string;
  name: string;
  provider?: string;
}

interface AgentCardProps {
  agent: { id: string; name: string; availableModels: ModelChip[] };
  selectedModels: Set<string>;
  onToggleModel: (agentId: string, modelDbId: string) => void;
  onRefreshModels: (agentId: string) => void;
  isRefreshing: boolean;
}

export function AgentCard({ agent, selectedModels, onToggleModel, onRefreshModels, isRefreshing }: AgentCardProps) {
  const hasSelected = agent.availableModels.some((m) => selectedModels.has(m.dbId));

  const handleToggle = useCallback(
    (modelDbId: string) => onToggleModel(agent.id, modelDbId),
    [agent.id, onToggleModel],
  );

  return (
    <div className={`rounded-lg border p-4 transition-colors ${
      hasSelected
        ? 'border-[var(--accent)] bg-[var(--bg-raised)]'
        : 'border-[var(--border)] bg-[var(--bg-base)]'
    }`}>
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">{agent.name}</span>
        <button
          onClick={() => onRefreshModels(agent.id)}
          disabled={isRefreshing}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
        >
          {isRefreshing ? 'Refreshing...' : 'Refresh models'}
        </button>
      </div>

      {agent.availableModels.length === 0 ? (
        <span className="text-xs text-[var(--text-muted)]">No models — click Refresh</span>
      ) : (
        <ModelCombobox
          models={agent.availableModels}
          selected={selectedModels}
          onToggle={handleToggle}
        />
      )}
    </div>
  );
}
