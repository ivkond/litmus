import { NextResponse } from 'next/server';
import { db } from '@/db';
import { scenarios } from '@/db/schema';
import { fetchScenarioList } from '@/lib/scenarios/queries';
import { uploadFile, BUCKETS } from '@/lib/s3';

export async function GET() {
  const items = await fetchScenarioList();
  return NextResponse.json(items);
}

export async function POST(request: Request) {
  const body = await request.json();

  if (!body.slug || !body.name) {
    return NextResponse.json(
      { error: 'slug and name are required' },
      { status: 400 },
    );
  }

  try {
    const [created] = await db
      .insert(scenarios)
      .values({
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
        version: body.version ?? 'v1',
        language: body.language ?? null,
        tags: body.tags ?? null,
        maxScore: body.maxScore ?? null,
      })
      .returning();

    // Upload initial files to S3 if provided
    // body.files is an optional Record<string, string> of { filename: content }
    const files = body.files as Record<string, string> | undefined;
    if (files) {
      for (const [filename, content] of Object.entries(files)) {
        await uploadFile(BUCKETS.scenarios, `${body.slug}/${filename}`, content, 'text/plain');
      }
    }

    return NextResponse.json(created, { status: 201 });
  } catch (err: unknown) {
    // Postgres unique_violation for slug
    if (err instanceof Error && (err as Error & { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'A scenario with this slug already exists' },
        { status: 409 },
      );
    }
    throw err;
  }
}
