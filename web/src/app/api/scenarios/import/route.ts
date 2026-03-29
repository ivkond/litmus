import { NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { db } from '@/db';
import { scenarios } from '@/db/schema';
import { uploadFile, BUCKETS } from '@/lib/s3';

interface PackManifest {
  version: string;
  scenarios: Array<{
    slug: string;
    name: string;
    description?: string;
    language: string;
    tags?: string[];
    maxScore?: number;
  }>;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const manifestEntry = entries.find((e) => e.entryName === 'manifest.json');
  if (!manifestEntry) {
    return NextResponse.json({ error: 'Missing manifest.json in pack' }, { status: 400 });
  }

  const manifest: PackManifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
  const imported: string[] = [];

  for (const scenarioDef of manifest.scenarios) {
    await db
      .insert(scenarios)
      .values({
        slug: scenarioDef.slug,
        name: scenarioDef.name,
        description: scenarioDef.description,
        language: scenarioDef.language,
        tags: scenarioDef.tags,
        maxScore: scenarioDef.maxScore,
      })
      .onConflictDoUpdate({
        target: scenarios.slug,
        set: {
          name: scenarioDef.name,
          description: scenarioDef.description,
          language: scenarioDef.language,
          tags: scenarioDef.tags,
          maxScore: scenarioDef.maxScore,
        },
      });

    const prefix = `${scenarioDef.slug}/`;
    for (const entry of entries) {
      if (entry.entryName.startsWith(prefix) && !entry.isDirectory) {
        await uploadFile(BUCKETS.scenarios, entry.entryName, entry.getData());
      }
    }

    imported.push(scenarioDef.slug);
  }

  return NextResponse.json({ imported, count: imported.length }, { status: 201 });
}
