export interface ScenarioFile {
  key: string;       // S3 key relative to scenario root, e.g. "prompt.txt"
  name: string;      // Display name, e.g. "prompt.txt"
  size: number;      // bytes (0 if unknown)
}

export interface ScenarioUsageStats {
  totalRuns: number;
  avgScore: number | null;
  bestScore: number | null;
  worstScore: number | null;
}

export interface ScenarioDetailResponse {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  language: string | null;
  tags: string[] | null;
  maxScore: number | null;
  createdAt: string;
  files: ScenarioFile[];
  usage: ScenarioUsageStats;
}

export interface ScenarioListItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  language: string | null;
  tags: string[] | null;
  maxScore: number | null;
  createdAt: string;
  totalRuns: number;
  avgScore: number | null;
}
