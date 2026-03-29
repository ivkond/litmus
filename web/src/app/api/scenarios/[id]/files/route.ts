import { NextResponse } from 'next/server';
import { db } from '@/db';
import { scenarios } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { downloadFile, uploadFile, BUCKETS } from '@/lib/s3';

function isS3NotFound(err: unknown): boolean {
  if (err instanceof Error) {
    const name = (err as Error & { name?: string }).name ?? '';
    return name === 'NoSuchKey' || name === 'NotFound';
  }
  return false;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const filePath = url.searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'path query param required' }, { status: 400 });
  }

  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!scenario) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  try {
    const buffer = await downloadFile(BUCKETS.scenarios, `${scenario.slug}/${filePath}`);
    const content = buffer.toString('utf-8');
    return NextResponse.json({ path: filePath, content });
  } catch (err) {
    if (isS3NotFound(err)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    console.error(`[files GET] S3 error for "${scenario.slug}/${filePath}":`, err);
    return NextResponse.json({ error: 'Storage service error' }, { status: 502 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { path: filePath, content } = body;

  if (!filePath || content === undefined) {
    return NextResponse.json({ error: 'path and content required' }, { status: 400 });
  }

  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, id));
  if (!scenario) {
    return NextResponse.json({ error: 'Scenario not found' }, { status: 404 });
  }

  await uploadFile(BUCKETS.scenarios, `${scenario.slug}/${filePath}`, content, 'text/plain');
  return NextResponse.json({ path: filePath, updated: true });
}
