import { NextResponse } from 'next/server';

// Placeholder — real implementation lands in Task 5 (Auth API Routes).
// The previous draft referenced the pre-migration `env_var` schema and was
// superseded by the ACP auth integration plan.

export async function GET() {
  return NextResponse.json({ error: 'Not implemented — see Task 5' }, { status: 501 });
}

export async function PUT() {
  return NextResponse.json({ error: 'Not implemented — see Task 5' }, { status: 501 });
}

export async function DELETE() {
  return NextResponse.json({ error: 'Not implemented — see Task 5' }, { status: 501 });
}
