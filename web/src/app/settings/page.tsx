import { Suspense } from 'react';
import { db } from '@/db';
import { agents, agentExecutors, settings } from '@/db/schema';
import { z } from 'zod';
import { AgentManager } from '@/components/settings/agent-manager';
import { JudgeProviders } from '@/components/settings/judge-providers';
import { ScoringConfig } from '@/components/settings/scoring-config';
import { GeneralSettings } from '@/components/settings/general-settings';
import type { GeneralSettingsData } from '@/components/settings/general-settings';
import type { AgentWithExecutors } from '@/components/settings/agent-form';
import { SettingsTabs } from './settings-tabs';

export const dynamic = 'force-dynamic';

const generalSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).catch('dark'),
  autoJudge: z.boolean().catch(false),
  maxConcurrentLanes: z.number().int().min(1).max(10).catch(3),
});

async function fetchAgentsWithExecutors(): Promise<AgentWithExecutors[]> {
  const allAgents = await db.select().from(agents).orderBy(agents.name);
  const allExecutors = await db.select().from(agentExecutors);

  return allAgents.map((agent) => ({
    ...agent,
    availableModels: (agent.availableModels ?? []) as unknown[],
    executors: allExecutors.filter((e) => e.agentId === agent.id),
  }));
}

async function fetchGeneralSettings(): Promise<GeneralSettingsData> {
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));

  return generalSettingsSchema.parse({
    theme: map.get('general_theme'),
    autoJudge: map.get('general_auto_judge'),
    maxConcurrentLanes: map.get('general_max_concurrent_lanes'),
  });
}

export default async function SettingsPage() {
  const [agentList, generalSettings] = await Promise.all([
    fetchAgentsWithExecutors(),
    fetchGeneralSettings(),
  ]);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold font-mono text-[var(--text-primary)]">Settings</h1>

      <Suspense fallback={<div className="text-sm text-[var(--text-muted)]">Loading...</div>}>
        <SettingsTabs
          sections={{
            agents: <AgentManager initialAgents={agentList} />,
            'judge-providers': <JudgeProviders />,
            scoring: <ScoringConfig />,
            general: <GeneralSettings initialSettings={generalSettings} />,
          }}
        />
      </Suspense>
    </div>
  );
}
