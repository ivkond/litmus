import type { AgentExecutor, ExecutorHandle } from '@/lib/orchestrator/types';
import { AcpSession } from '@/lib/orchestrator/acp-session';
import { resolveAcpConfig } from '@/lib/orchestrator/acp-config';
import { saveCredentialBlob } from '@/lib/agents/secrets';
import { extractCredentials } from '@/lib/orchestrator/credential-files';

const URL_REGEX = /https?:\/\/[^\s"'<>]+/g;
const DEVICE_CODE_REGEX = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
const CODE_CONTEXT_KEYWORDS = /code|device|enter|verification|one.?time/i;

export function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_REGEX)].map((m) => m[0]);
}

export function detectDeviceCode(lines: string[], urlLineIndex: number): string | null {
  const start = Math.max(0, urlLineIndex - 2);
  const end = Math.min(lines.length, urlLineIndex + 3);

  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!CODE_CONTEXT_KEYWORDS.test(line) && i !== urlLineIndex) continue;

    const match = line.match(DEVICE_CODE_REGEX);
    if (match) return match[0];
  }
  return null;
}

export type OAuthEvent =
  | { type: 'starting' }
  | { type: 'awaiting_browser'; url: string; deviceCode: string | null }
  | { type: 'completed'; acpMethodId: string }
  | { type: 'failed'; error: string };

const activeCaptures = new Map<string, AbortController>();

export function isCaptureLocked(executorId: string): boolean {
  return activeCaptures.has(executorId);
}

export function lockCapture(executorId: string): AbortController {
  if (activeCaptures.has(executorId)) {
    throw new Error('OAuth capture already in progress');
  }
  const controller = new AbortController();
  activeCaptures.set(executorId, controller);
  return controller;
}

export function unlockCapture(executorId: string): void {
  const controller = activeCaptures.get(executorId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  activeCaptures.delete(executorId);
}

const URL_CAPTURE_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 300_000;

export async function captureOAuthCredentials(params: {
  executor: AgentExecutor;
  handle: ExecutorHandle;
  executorId: string;
  agentType: string;
  acpMethodId: string;
  signal: AbortSignal;
  emit: (event: OAuthEvent) => void;
}): Promise<void> {
  const { executor, handle, executorId, agentType, acpMethodId, signal, emit } = params;

  emit({ type: 'starting' });

  const acpConfig = resolveAcpConfig(agentType);
  const credentialPaths = acpConfig.credentialPaths ?? [];

  let session: AcpSession | null = null;

  try {
    const { session: acpSession } = await AcpSession.startForDiscovery(
      executor, handle, acpConfig,
    );
    session = acpSession;

    const proc = session.getProc();
    const outputLines: string[] = [];
    let urlFound = false;

    const urlPromise = new Promise<{ url: string; deviceCode: string | null }>((resolve, reject) => {
      const urlTimeout = setTimeout(() => {
        reject(new Error('URL capture timeout: no authentication URL detected within 30s'));
      }, URL_CAPTURE_TIMEOUT_MS);

      const processLine = (line: string) => {
        outputLines.push(line);
        const urls = extractUrls(line);
        if (urls.length > 0 && !urlFound) {
          urlFound = true;
          clearTimeout(urlTimeout);
          const deviceCode = detectDeviceCode(outputLines, outputLines.length - 1);
          resolve({ url: urls[0], deviceCode });
        }
      };

      let stdoutBuf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      let stderrBuf = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      signal.addEventListener('abort', () => {
        clearTimeout(urlTimeout);
        reject(new Error('OAuth capture aborted'));
      });
    });

    const authPromise = session.authenticate(acpMethodId);

    const { url, deviceCode } = await urlPromise;
    emit({ type: 'awaiting_browser', url, deviceCode });

    const overallTimeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), OVERALL_TIMEOUT_MS),
    );

    const completionPromise: Promise<'completed'> = authPromise.then(() => 'completed' as const);

    const result = await Promise.race([completionPromise, overallTimeout]);

    if (result === 'timeout') {
      emit({ type: 'failed', error: 'OAuth flow timed out after 300s' });
      return;
    }

    if (credentialPaths.length > 0) {
      try {
        const base64Tar = await extractCredentials(executor, handle, credentialPaths);
        await saveCredentialBlob({
          executorId,
          acpMethodId,
          base64Tar,
          credentialPaths,
        });
        emit({ type: 'completed', acpMethodId });
      } catch (extractError) {
        emit({
          type: 'failed',
          error: `Auth completed but credential extraction failed: ${extractError instanceof Error ? extractError.message : String(extractError)}`,
        });
      }
    } else {
      emit({ type: 'completed', acpMethodId });
    }
  } catch (error) {
    if (signal.aborted) return;
    emit({
      type: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (session) {
      try { await session.close(); } catch { /* best effort */ }
    }
  }
}