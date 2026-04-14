import { NextResponse } from 'next/server';
import { db } from '@/db';
import { settings } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { settingsSchemas, settingsDefaults } from '@/lib/judge/types';

async function getSettingsMap(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(settings);
  const map: Record<string, unknown> = { ...settingsDefaults };
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

export async function GET() {
  const map = await getSettingsMap();
  return NextResponse.json(map);
}

export async function PUT(request: Request) {
  const body = await request.json();
  const errors: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    const schema = settingsSchemas[key];
    if (!schema) {
      errors.push(`Unknown setting key: ${key}`);
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      errors.push(`${key}: ${result.error.message}`);
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 422 });
  }

  // Upsert each setting
  for (const [key, value] of Object.entries(body)) {
    await db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  const updated = await getSettingsMap();
  return NextResponse.json(updated);
}

export async function DELETE() {
  // Delete all scoring-related settings, reverting to defaults
  const scoringKeys = Object.keys(settingsDefaults);
  if (scoringKeys.length > 0) {
    await db.delete(settings).where(inArray(settings.key, scoringKeys));
  }
  // Return defaults
  return NextResponse.json({ ...settingsDefaults });
}
