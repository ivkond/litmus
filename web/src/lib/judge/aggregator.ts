import type { JudgeCriterionScore, JudgeBlockingFlag, AggregatedScores } from './types';

export function median(values: number[]): number {
  if (values.length === 0) throw new Error('Cannot compute median of empty array');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function majorityVote(votes: boolean[]): boolean {
  const trueCount = votes.filter(Boolean).length;
  return trueCount > votes.length / 2;
}

export function computeCompositeScore(params: {
  testScore: number;
  judgeNormalized: number;
  weights: { test: number; judge: number };
  blockingCount: number;
  blockingCaps: Record<string, number>;
}): number {
  const { testScore, judgeNormalized, weights, blockingCount, blockingCaps } = params;
  let composite = weights.test * testScore + weights.judge * judgeNormalized;

  if (blockingCount >= 2) {
    composite = Math.min(composite, blockingCaps['2'] ?? 40);
  } else if (blockingCount === 1) {
    composite = Math.min(composite, blockingCaps['1'] ?? 60);
  }

  return composite;
}

interface VerdictInput {
  scores: Record<string, JudgeCriterionScore>;
  blockingFlags: Record<string, JudgeBlockingFlag>;
  error: string | null;
}

export function aggregateVerdicts(
  verdicts: VerdictInput[],
  criteriaKeys: string[],
  blockingKeys: string[]
): AggregatedScores | null {
  const successful = verdicts.filter((v) => v.error == null);
  const S = successful.length;
  const N = verdicts.length;

  if (S === 0) return null;

  const halfN = Math.ceil(N / 2);
  const confidence = S >= halfN ? 'normal' : 'lowConfidence';

  const medianScores: Record<string, number> = {};
  for (const key of criteriaKeys) {
    const scores = successful
      .map((v) => v.scores[key]?.score)
      .filter((s): s is number => s != null);
    medianScores[key] = scores.length > 0 ? median(scores) : 0;
  }

  const blockingFlags: Record<string, boolean> = {};
  for (const key of blockingKeys) {
    const votes = successful
      .map((v) => v.blockingFlags[key]?.triggered)
      .filter((v): v is boolean => v != null);
    if (confidence === 'lowConfidence') {
      blockingFlags[key] = votes.length > 0 && votes.every(Boolean);
    } else {
      blockingFlags[key] = votes.length > 0 ? majorityVote(votes) : false;
    }
  }

  const blockingCount = Object.values(blockingFlags).filter(Boolean).length;

  return {
    medianScores,
    blockingFlags,
    judgeWeighted: 0,
    judgeNormalized: 0,
    compositeScore: 0,
    blockingCount,
    confidence,
  };
}
