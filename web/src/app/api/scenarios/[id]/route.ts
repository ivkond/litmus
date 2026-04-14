import { NextResponse } from 'next/server';
import { db, sql } from '@/db';
import { scenarios } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { listFiles, deleteFile, BUCKETS } from '@/lib/s3';
import type { ScenarioDetailResponse, ScenarioFile } from '@/lib/scenarios/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!scenario) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  // Usage stats from run_results
  const statsRows = await sql`
    SELECT COUNT(*) AS total_runs,
           AVG(total_score) AS avg_score,
           MAX(total_score) AS best_score,
           MIN(total_score) AS worst_score
    FROM run_results
    WHERE scenario_id = ${id}
      AND status IN ('completed', 'failed')
  `;
  const stats = (statsRows as Array<Record<string, unknown>>)[0] ?? {};

  // Project files from S3 (prompt/task/scoring are in DB now)
  let files: ScenarioFile[] = [];
  try {
    const keys = await listFiles(BUCKETS.scenarios, `${scenario.slug}/`);
    files = keys
      .map((key) => key.replace(`${scenario.slug}/`, ''))
      .filter((rel) => rel.startsWith('project/'))
      .map((rel) => ({ key: rel, name: rel, size: 0 }));
  } catch (err) {
    console.error(`[scenario GET] S3 listFiles failed for "${scenario.slug}/":`, err);
  }

  const response: ScenarioDetailResponse = {
    id: scenario.id,
    slug: scenario.slug,
    name: scenario.name,
    description: scenario.description,
    version: scenario.version,
    language: scenario.language,
    tags: scenario.tags,
    maxScore: scenario.maxScore,
    prompt: scenario.prompt,
    task: scenario.task,
    scoring: scenario.scoring,
    createdAt: scenario.createdAt?.toISOString() ?? new Date().toISOString(),
    files,
    usage: {
      totalRuns: Number(stats.total_runs ?? 0),
      avgScore: stats.avg_score != null ? Number(stats.avg_score) : null,
      bestScore: stats.best_score != null ? Number(stats.best_score) : null,
      worstScore: stats.worst_score != null ? Number(stats.worst_score) : null,
    },
  };

  return NextResponse.json(response);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();

  const [existing] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!existing) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  const updates: Partial<typeof scenarios.$inferInsert> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.version !== undefined) updates.version = body.version;
  if (body.language !== undefined) updates.language = body.language;
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.maxScore !== undefined) updates.maxScore = body.maxScore;
  if (body.prompt !== undefined) updates.prompt = body.prompt;
  if (body.task !== undefined) updates.task = body.task;
  if (body.scoring !== undefined) updates.scoring = body.scoring;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(existing);
  }

  const [updated] = await db
    .update(scenarios)
    .set(updates)
    .where(eq(scenarios.id, id))
    .returning();

  return NextResponse.json(updated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [existing] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!existing) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  // DB-first: delete the record so it's no longer visible even if S3 cleanup fails
  await db.delete(scenarios).where(eq(scenarios.id, id));

  // Best-effort S3 cleanup — log failures but don't fail the request
  try {
    const keys = await listFiles(BUCKETS.scenarios, `${existing.slug}/`);
    for (const key of keys) {
      try {
        await deleteFile(BUCKETS.scenarios, key);
      } catch (err) {
        console.error(`[DELETE scenario] Failed to delete S3 key "${key}":`, err);
      }
    }
  } catch (err) {
    console.error(`[DELETE scenario] Failed to list S3 files for "${existing.slug}":`, err);
  }

  return NextResponse.json({ deleted: true });
}
