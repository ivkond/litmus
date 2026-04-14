export type LensType = 'model-ranking' | 'agent-ranking' | 'agent-x-models' | 'model-x-agents';

export interface HeatmapCell {
  score: number;
  bestInRow: boolean;
  stale: boolean;
  errorOnly: boolean;
  errorCount?: number;
  testsPassed?: number;
  testsTotal?: number;
  status?: 'completed' | 'failed';
  counterpartCount?: number;
  staleCount?: number;
  sourceCount?: number;
  judgeStatus?: 'pending' | 'partial' | 'completed' | 'skipped';
}

export interface LeaderboardEntry {
  rank: number;
  entityId: string;
  entityName: string;
  avgScore: number;
  scenarioCount: number;
  totalScenarios: number;
  counterpartCount: number;
  lowCoverage: boolean;
  judgedCount?: number;
  judgedTotal?: number;
}

export interface CompareResponse {
  lens: LensType;
  anchor?: { id: string; name: string };
  availableAnchors?: { id: string; name: string }[];
  canonicalParams: { lens: string; agentId?: string; modelId?: string };
  leaderboard: LeaderboardEntry[];
  heatmap: {
    columns: { id: string; name: string }[];
    rows: { id: string; slug: string; name: string }[];
    cells: Record<string, Record<string, HeatmapCell | null>>;
    totals: Record<string, number>;
  };
  participants: {
    agentIds: string[];
    modelIds: string[];
    scenarioIds: string[];
  };
}

export interface BreakdownResponse {
  scenario: { id: string; slug: string; name: string };
  entity: { id: string; name: string; type: 'model' | 'agent' };
  avgScore: number | null;
  breakdown: {
    counterpartId: string;
    counterpartName: string;
    score: number;
    testsPassed: number;
    testsTotal: number;
    status: 'completed' | 'failed';
    stale: boolean;
    createdAt: string;
  }[];
  errorOnlyCounterparts: {
    counterpartId: string;
    counterpartName: string;
    errorCount: number;
    lastErrorAt: string;
    lastErrorMessage: string | null;
  }[];
}

export interface DrillDownResponse {
  scenario: { id: string; slug: string; name: string };
  agent: { id: string; name: string };
  model: { id: string; name: string };
  latest: null | {
    runResultId: string;
    runId: string;
    score: number;
    testsPassed: number;
    testsTotal: number;
    durationSeconds: number;
    attempt: number;
    maxAttempts: number;
    status: 'completed' | 'failed';
    agentVersion: string | null;
    scenarioVersion: string | null;
    judgeScores: Record<string, number> | null;
    artifactsS3Key: string | null;
    errorMessage: string | null;
    createdAt: string;
    judgeStatus: 'pending' | 'partial' | 'completed' | 'skipped' | null;
    compositeScore: number | null;
    blockingFlags: Record<string, boolean> | null;
    judgeVerdicts: {
      providerName: string;
      scores: Record<string, { score: number; rationale: string }>;
      blocking: Record<string, { triggered: boolean; rationale: string }>;
      createdAt: string;
      error: string | null;
    }[] | null;
  };
  history: {
    runId: string;
    score: number;
    testsPassed: number;
    testsTotal: number;
    durationSeconds: number;
    status: 'completed' | 'failed' | 'error';
    agentVersion: string | null;
    scenarioVersion: string | null;
    artifactsS3Key: string | null;
    errorMessage: string | null;
    createdAt: string;
    trend: number | null;
    isLatest: boolean;
  }[];
}
