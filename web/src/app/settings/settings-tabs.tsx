'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

export const SETTINGS_TABS = [
  { key: 'agents', label: 'Agents' },
  { key: 'judge-providers', label: 'Judge Providers' },
  { key: 'scoring', label: 'Scoring' },
  { key: 'general', label: 'General' },
] as const;

export type SettingsTabKey = (typeof SETTINGS_TABS)[number]['key'];

interface Props {
  sections: Record<SettingsTabKey, ReactNode>;
}

export function SettingsTabs({ sections }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawTab = searchParams.get('tab');
  const activeTab: SettingsTabKey =
    SETTINGS_TABS.some((t) => t.key === rawTab)
      ? (rawTab as SettingsTabKey)
      : 'agents';

  function handleTabClick(key: SettingsTabKey) {
    if (key === activeTab) return;
    router.push(`/settings?tab=${key}`);
  }

  return (
    <div>
      {/* Tab bar — underline style matching Compare tab-bar.tsx */}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {SETTINGS_TABS.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              onClick={() => handleTabClick(tab.key)}
              className={`whitespace-nowrap px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                isActive
                  ? 'border-b-2 border-[var(--accent)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Active section */}
      <div>{sections[activeTab]}</div>
    </div>
  );
}
