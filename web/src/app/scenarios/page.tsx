import { fetchScenarioList } from '@/lib/scenarios/queries';
import { ScenariosLibrary } from './scenarios-library';

export const dynamic = 'force-dynamic';

export default async function ScenariosPage() {
  const scenarios = await fetchScenarioList();
  return <ScenariosLibrary scenarios={scenarios} />;
}
