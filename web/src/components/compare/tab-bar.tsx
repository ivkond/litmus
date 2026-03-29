'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { LensType } from '@/lib/compare/types';

const TABS: Array<{ lens: LensType; label: string; color: string }> = [
  { lens: 'model-ranking', label: 'Model Ranking', color: 'var(--lens-ranking)' },
  { lens: 'agent-ranking', label: 'Agent Ranking', color: 'var(--lens-ranking)' },
  { lens: 'agent-x-models', label: 'Agent x Models', color: 'var(--lens-detail)' },
  { lens: 'model-x-agents', label: 'Model x Agents', color: 'var(--lens-detail)' },
];

interface Props {
  activeLens: LensType;
}

export function TabBar({ activeLens }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function buildHref(nextLens: LensType): string {
    if (nextLens === 'agent-x-models') {
      const agentId = searchParams.get('agentId');
      return agentId ? `/compare?lens=${nextLens}&agentId=${agentId}` : `/compare?lens=${nextLens}`;
    }

    if (nextLens === 'model-x-agents') {
      const modelId = searchParams.get('modelId');
      return modelId ? `/compare?lens=${nextLens}&modelId=${modelId}` : `/compare?lens=${nextLens}`;
    }

    return `/compare?lens=${nextLens}`;
  }

  return (
    <div className="mb-4 flex gap-1 border-b border-[var(--border)]">
      {TABS.map((tab) => {
        const active = tab.lens === activeLens;
        return (
          <button
            key={tab.lens}
            onClick={() => router.push(buildHref(tab.lens))}
            className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
              active
                ? 'border-b-2 text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
            style={active ? { borderBottomColor: tab.color, backgroundColor: `${tab.color}15` } : undefined}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
