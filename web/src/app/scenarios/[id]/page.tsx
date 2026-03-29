import { notFound } from 'next/navigation';
import { fetchScenarioDetail } from '@/lib/scenarios/queries';
import { ScenarioHeader } from './scenario-header';
import { ScenarioTabs } from './scenario-tabs';
import { ScenarioSidebar } from './scenario-sidebar';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ScenarioDetailPage({ params }: Props) {
  const { id } = await params;
  const data = await fetchScenarioDetail(id);

  if (!data) {
    notFound();
  }

  return (
    <div className="space-y-4">
      <ScenarioHeader data={data} />
      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          <ScenarioTabs data={data} />
        </div>
        <div className="w-64 flex-shrink-0">
          <ScenarioSidebar data={data} />
        </div>
      </div>
    </div>
  );
}
