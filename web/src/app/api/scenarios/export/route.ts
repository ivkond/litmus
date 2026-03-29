import { NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { db } from '@/db';
import { scenarios } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { listFiles, downloadFile, BUCKETS } from '@/lib/s3';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const idsParam = url.searchParams.get('ids');

  if (!idsParam) {
    return NextResponse.json({ error: 'ids query parameter required (comma-separated)' }, { status: 400 });
  }

  const ids = idsParam.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids query parameter required (comma-separated)' }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(scenarios)
    .where(inArray(scenarios.id, ids));

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No matching scenarios found' }, { status: 404 });
  }

  const zip = new AdmZip();

  // Build manifest matching .litmus-pack spec
  const manifest = {
    version: 1,
    kind: 'scenarios',
    created_at: new Date().toISOString(),
    scenarios: rows.map((s) => ({
      slug: s.slug,
      name: s.name,
      version: s.version ?? 'v1',
      language: s.language ?? undefined,
      description: s.description ?? undefined,
      tags: s.tags ?? undefined,
      maxScore: s.maxScore ?? undefined,
    })),
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

  // Add files for each scenario
  for (const scenario of rows) {
    const keys = await listFiles(BUCKETS.scenarios, `${scenario.slug}/`);
    for (const key of keys) {
      const buffer = await downloadFile(BUCKETS.scenarios, key);
      zip.addFile(key, buffer);
    }
  }

  const zipBuffer = zip.toBuffer();

  return new NextResponse(zipBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="scenarios-${Date.now()}.litmus-pack"`,
    },
  });
}
