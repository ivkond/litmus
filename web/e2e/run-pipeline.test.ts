import { describe, it, expect, beforeAll } from 'vitest';
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * Ping the server once before running network tests.
 * Returns true if the server responds, false otherwise.
 */
async function isServerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/scenarios`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Set by beforeAll; guards tests that require a live server. */
let serverAvailable = false;

describe('E2E Pipeline Scaffold', () => {
  beforeAll(async () => {
    serverAvailable = await isServerReachable();
    if (!serverAvailable) {
      console.warn(
        `\n⚠  E2E server not reachable at ${BASE_URL}.\n` +
        `   Network tests will be skipped.\n` +
        `   Set E2E_BASE_URL or start the server before running test:e2e.\n`,
      );
    }
  });

  it('packs __test__ scenarios into a .litmus-pack', () => {
    const scenariosDir = path.resolve(__dirname, '../agents/scenarios/__test__');
    const zip = new AdmZip();

    const dirs = fs.readdirSync(scenariosDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const manifest = {
      version: '1',
      scenarios: dirs.map((d) => ({
        slug: d.name,
        name: d.name.replace(/^\d+-/, '').replace(/-/g, ' '),
        language: 'python',
        tags: [],
        maxScore: 100,
      })),
    };

    for (const dir of dirs) {
      const dirPath = path.join(scenariosDir, dir.name);
      addDirToZip(zip, dirPath, dir.name);
    }

    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    // Verify the pack is valid
    const entries = zip.getEntries();
    expect(entries.some((e) => e.entryName === 'manifest.json')).toBe(true);
    expect(manifest.scenarios.length).toBeGreaterThan(0);
  });

  it('imports scenarios via POST /api/scenarios/import', async ({ skip }) => {
    if (!serverAvailable) skip();
    // Build pack in memory
    const scenariosDir = path.resolve(__dirname, '../agents/scenarios/__test__');
    const zip = new AdmZip();
    const dirs = fs.readdirSync(scenariosDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const manifest = {
      version: '1',
      scenarios: dirs.map((d) => ({
        slug: d.name,
        name: d.name.replace(/^\d+-/, '').replace(/-/g, ' '),
        language: 'python',
        tags: [],
        maxScore: 100,
      })),
    };

    for (const dir of dirs) {
      addDirToZip(zip, path.join(scenariosDir, dir.name), dir.name);
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    const buffer = zip.toBuffer();
    const formData = new FormData();
    formData.append('file', new Blob([buffer]), 'test.litmus-pack');

    const res = await fetch(`${BASE_URL}/api/scenarios/import`, {
      method: 'POST',
      body: formData,
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.count).toBeGreaterThan(0);
  });

  it('registers mock agent via POST /api/agents', async ({ skip }) => {
    if (!serverAvailable) skip();
    const res = await fetch(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'e2e-mock-agent',
        version: '1.0.0',
        executor: {
          type: 'docker',
          agentSlug: 'mock',
        },
      }),
    });

    // 201 = created, 409 or similar if already exists
    expect([200, 201]).toContain(res.status);
    const data = await res.json();
    expect(data.name).toBe('e2e-mock-agent');
  });
});

function addDirToZip(z: AdmZip, dirPath: string, zipPrefix: string): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = `${zipPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      addDirToZip(z, fullPath, zipPath);
    } else {
      z.addFile(zipPath, fs.readFileSync(fullPath));
    }
  }
}
