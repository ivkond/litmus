import { redirect } from 'next/navigation';
import { fetchCompareData } from '@/lib/compare/queries';
import type { LensType } from '@/lib/compare/types';
import { CompareView } from './compare-view';

export const dynamic = 'force-dynamic';

const VALID_LENSES: LensType[] = ['model-ranking', 'agent-ranking', 'agent-x-models', 'model-x-agents'];

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lensParam = typeof params.lens === 'string' ? params.lens : undefined;
  const agentId = typeof params.agentId === 'string' ? params.agentId : undefined;
  const modelId = typeof params.modelId === 'string' ? params.modelId : undefined;

  const lens: LensType = VALID_LENSES.includes(lensParam as LensType)
    ? (lensParam as LensType)
    : 'model-ranking';

  if (lensParam !== lens) {
    redirect(`/compare?lens=${lens}`);
  }

  const normalizedAgentId = lens === 'agent-x-models' ? agentId : undefined;
  const normalizedModelId = lens === 'model-x-agents' ? modelId : undefined;

  const data = await fetchCompareData({
    lens,
    agentId: normalizedAgentId,
    modelId: normalizedModelId,
  });

  const currentUrl = buildUrl(lens, agentId, modelId);
  const canonicalUrl = buildUrl(data.canonicalParams.lens, data.canonicalParams.agentId, data.canonicalParams.modelId);
  if (currentUrl !== canonicalUrl) {
    redirect(canonicalUrl);
  }

  return <CompareView data={data} />;
}

function buildUrl(lens: string, agentId?: string, modelId?: string): string {
  const parts = [`/compare?lens=${lens}`];
  if (agentId) parts.push(`agentId=${agentId}`);
  if (modelId) parts.push(`modelId=${modelId}`);
  return parts.join('&');
}
