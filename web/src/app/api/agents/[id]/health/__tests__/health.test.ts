import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockExecutorType: string | null = 'docker';
let mockHealthResult = true;
let mockImageExists = true;
let mockExecutorBinaryPath: string | null = null;

vi.mock('@/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const executorData = mockExecutorType
            ? { id: 'e1', agentId: 'a1', type: mockExecutorType, binaryPath: mockExecutorBinaryPath }
            : undefined;
          const result = Promise.resolve(executorData ? [executorData] : []);
          (result as unknown as Record<string, unknown>).limit = vi.fn().mockImplementation(() => {
            return Promise.resolve(executorData ? [executorData] : []);
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
    checkImage() {
      return Promise.resolve(mockImageExists);
    }
  },
}));

vi.mock('@/lib/env', () => ({
  env: { DOCKER_HOST: 'unix:///var/run/docker.sock' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn().mockRejectedValue(new Error('not implemented in test')),
}));

describe('POST /api/agents/[id]/health', () => {
  beforeEach(() => {
    mockExecutorType = 'docker';
    mockHealthResult = true;
    mockImageExists = true;
    mockExecutorBinaryPath = null;
  });

  it('returns healthy for docker executor when daemon and image OK', async () => {
    const { POST } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1/health', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.healthy).toBe(true);
    expect(body.image).toBe('litmus/runtime-python');
  });

  it('returns unhealthy when docker daemon unreachable', async () => {
    mockHealthResult = false;
    const { POST } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1/health', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.healthy).toBe(false);
    expect(body.reason).toBe('docker-daemon-unreachable');
  });

  it('returns unhealthy when runtime image not pulled', async () => {
    mockImageExists = false;
    const { POST } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1/health', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.healthy).toBe(false);
    expect(body.reason).toBe('runtime-image-missing');
  });

  it('returns 404 when agent has no executor', async () => {
    mockExecutorType = null;
    const { POST } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1/health', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(404);
  });

  it('returns 501 for kubernetes executor type', async () => {
    mockExecutorType = 'kubernetes';
    const { POST } = await import('../route');
    const request = new Request('http://localhost/api/agents/a1/health', { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'a1' }) });

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.error).toContain('kubernetes');
  });
});