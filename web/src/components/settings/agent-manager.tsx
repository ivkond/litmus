'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AgentForm } from './agent-form';
import type { AgentWithExecutors } from './agent-form';

interface Props {
  initialAgents: AgentWithExecutors[];
}

export function AgentManager({ initialAgents }: Props) {
  const router = useRouter();
  const [agents, setAgents] = useState(initialAgents);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [healthStatus, setHealthStatus] = useState<Record<string, 'checking' | 'healthy' | 'unhealthy' | 'unsupported'>>({});
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refreshAgents = useCallback(async () => {
    const res = await fetch('/api/agents');
    if (!res.ok) return;
    const data = await res.json();
    setAgents(data);
    router.refresh();
  }, [router]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this agent and its executor config?')) return;
    setDeleteError(null);
    const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setDeleteError(data?.error ?? `Delete failed (${res.status})`);
      return;
    }
    await refreshAgents();
  }, [refreshAgents]);

  const handleHealthCheck = useCallback(async (agentId: string) => {
    setHealthStatus((prev) => ({ ...prev, [agentId]: 'checking' }));
    try {
      const res = await fetch(`/api/agents/${agentId}/health`, { method: 'POST' });
      if (!res.ok) {
        const status = res.status === 501 ? 'unsupported' as const : 'unhealthy' as const;
        setHealthStatus((prev) => ({ ...prev, [agentId]: status }));
        return;
      }
      const data = await res.json();
      setHealthStatus((prev) => ({ ...prev, [agentId]: data.healthy ? 'healthy' : 'unhealthy' }));
    } catch {
      setHealthStatus((prev) => ({ ...prev, [agentId]: 'unhealthy' }));
    }
  }, []);

  const handleDiscoverModels = useCallback(async (agentId: string) => {
    setDiscovering(agentId);
    try {
      const res = await fetch(`/api/agents/${agentId}/models`, { method: 'POST' });
      if (res.ok) await refreshAgents();
    } finally {
      setDiscovering(null);
    }
  }, [refreshAgents]);

  const modelCount = (agent: AgentWithExecutors) => {
    const count = (agent.availableModels ?? []).length;
    return `${count} model${count !== 1 ? 's' : ''}`;
  };

  const healthBadge = (agentId: string) => {
    const status = healthStatus[agentId];
    if (!status) return null;
    if (status === 'checking') return <Badge>checking…</Badge>;
    if (status === 'healthy') return <Badge variant="success">healthy</Badge>;
    if (status === 'unsupported') return <Badge>unsupported</Badge>;
    return <Badge variant="error">unhealthy</Badge>;
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold font-mono text-[var(--text-primary)]">Agents</h2>
        <button
          onClick={() => setAdding(!adding)}
          className="px-3 py-1.5 rounded-md text-sm font-mono
            bg-[var(--accent-dim)] text-[var(--accent)]
            hover:bg-[var(--accent)] hover:text-[var(--bg-base)]
            transition-colors"
        >
          {adding ? 'Cancel' : '+ Add Agent'}
        </button>
      </div>

      {deleteError && (
        <div className="text-xs font-mono text-[var(--score-fail)] bg-[var(--score-fail-bg)] px-3 py-2 rounded-md mb-4">
          {deleteError}
        </div>
      )}

      {adding && (
        <Card className="mb-4">
          <AgentForm
            onSave={async () => {
              setAdding(false);
              await refreshAgents();
            }}
            onCancel={() => setAdding(false)}
          />
        </Card>
      )}

      {agents.length === 0 && !adding && (
        <Card>
          <p className="text-sm text-[var(--text-muted)] text-center py-6">
            No agents configured. Add an agent to start running benchmarks.
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {agents.map((agent) => (
          <Card key={agent.id}>
            {editing === agent.id ? (
              <AgentForm
                agent={agent}
                onSave={async () => {
                  setEditing(null);
                  await refreshAgents();
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-medium text-[var(--text-primary)]">
                    {agent.name}
                  </span>
                  {agent.version && <Badge>v{agent.version}</Badge>}
                  {agent.executors[0] && (
                    <Badge variant="accent">{agent.executors[0].type}</Badge>
                  )}
                  <span className="text-xs text-[var(--text-muted)] font-mono">
                    {modelCount(agent)}
                  </span>
                  {healthBadge(agent.id)}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleHealthCheck(agent.id)}
                    disabled={healthStatus[agent.id] === 'checking'}
                    className="px-2 py-1 text-xs font-mono rounded
                      text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                      hover:bg-[var(--bg-hover)] transition-colors
                      disabled:opacity-50"
                    title="Check executor health"
                  >
                    Health
                  </button>
                  <button
                    onClick={() => handleDiscoverModels(agent.id)}
                    disabled={discovering === agent.id}
                    className="px-2 py-1 text-xs font-mono rounded
                      text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                      hover:bg-[var(--bg-hover)] transition-colors
                      disabled:opacity-50"
                    title="Discover available models"
                  >
                    {discovering === agent.id ? 'Discovering…' : 'Models'}
                  </button>
                  <button
                    onClick={() => setEditing(agent.id)}
                    className="px-2 py-1 text-xs font-mono rounded
                      text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                      hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(agent.id)}
                    className="px-2 py-1 text-xs font-mono rounded
                      text-[var(--score-fail)] hover:bg-[var(--score-fail-bg)]
                      transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}
