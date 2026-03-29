import { JudgeProviders } from '@/components/settings/judge-providers';
import { ScoringConfig } from '@/components/settings/scoring-config';

export default function SettingsPage() {
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      <JudgeProviders />
      <hr />
      <ScoringConfig />
    </div>
  );
}
