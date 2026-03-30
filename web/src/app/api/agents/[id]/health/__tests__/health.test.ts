import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockExecutorType: string | null = 'docker';
let mockHealthResult = true;

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const result = Promise.resolve(
            mockExecutorType
              ? [{ id: 'e1', agentId: 'a1', type: mockExecutorType }]
              : [],
          );
          (result as unknown as Record<string, unknown>).limit = vi.fn().mockImplementation(() => {
            return Promise.resolve(
              mockExecutorType
                ? [{ id: 'e1', agentId: 'a1', type: mockExecutorType }]
                : [],
            );
          });
          return result;
        }),
      }),
    }),
  },
}));

vi.mock('@/db/schema', () => ({
  agentExecutors: { agentId: 'agentExecutors.agentId', name: 'agentExecutors' },
}));

vi.mock('@/lib/orchestrator/docker-executor', () => ({
  DockerExecutor: class {
    healthCheck() {
      return Promise.resolve(mockHealthResult);
    }
  },
}));

vi.mock('@/lib/env', () => ({
  env: { DOCKER_HOST: 'unix:///var/run/docker.sock' },
}));

describe('POST /api/agents/[id]/health', () => {
  beforeEach(() => {
    mockExecutorType = 'docker';
    mockHealthResult = true;
    vi.clearAllMocks();
  });

  it('returns healthy for docker executor', async () => {
    const { POST } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1/health', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.healthy).toBe(true);
  });

  it('returns unhealthy when docker check fails', async () => {
    mockHealthResult = false;
    const { POST } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1/health', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.healthy).toBe(false);
  });

  it('returns 404 when agent has no executor', async () => {
    mockExecutorType = null;
    const { POST } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1/health', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(404);
  });

  it('returns 501 for non-docker executor types', async () => {
    mockExecutorType = 'host';
    const { POST } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1/health', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error).toContain('host');
  });
});
