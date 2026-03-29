'use client';

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
      <div className="flex flex-wrap gap-2">
        {agent.availableModels.length === 0 && (
          <span className="text-xs text-[var(--text-muted)]">No models — click Refresh</span>
        )}
        {agent.availableModels.map((model) => {
          const isSelected = selectedModels.has(model.dbId);
          return (
            <button
              key={model.dbId}
              onClick={() => onToggleModel(agent.id, model.dbId)}
              className={`font-mono text-xs px-2.5 py-1 rounded-full border transition-colors ${
                isSelected
                  ? 'bg-[var(--accent-dim)] text-[var(--accent)] border-[var(--accent)]'
                  : 'text-[var(--text-muted)] border-[var(--border)] hover:border-[var(--text-secondary)]'
              }`}
            >
              {model.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
