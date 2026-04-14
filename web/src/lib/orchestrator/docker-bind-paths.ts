import path from 'path';

const WIN_ABS_RE = /^[A-Za-z]:[/\\]/;

/** Recognises both POSIX (`/...`) and Windows (`C:\...`, `C:/...`) absolute paths. */
function isAbsoluteOnAnyOS(p: string): boolean {
  return path.isAbsolute(p) || WIN_ABS_RE.test(p);
}

/**
 * Join segments to a base that may be a Windows host path.
 * Inside a Linux container `path.resolve('C:\\foo', 'bar')` prepends cwd — wrong.
 * For Windows paths we join with '/' which Docker Desktop translates correctly.
 */
function joinHostPath(base: string, ...segments: string[]): string {
  if (WIN_ABS_RE.test(base)) {
    const normalized = base.replaceAll('\\', '/').replace(/\/+$/, '');
    return [normalized, ...segments].join('/');
  }
  return path.resolve(base, ...segments);
}

function requireAbsoluteOnDockerHost(relativeDisplay: string, envName: string): never {
  throw new Error(
    `${envName} must be an absolute path on the machine running the Docker Engine (got "${relativeDisplay}"). ` +
      'Docker bind mounts cannot use paths relative to the Litmus container. Set the full host path, e.g. the value printed by `pwd` / `(Resolve-Path .).Path` for the web directory.',
  );
}

/**
 * Normalise a host path for Docker bind mounts.
 * Windows `C:\foo\bar` → `/c/foo/bar` (MSYS / Docker Desktop convention).
 * This avoids the "too many colons" error when Docker parses `C:/foo:/container:ro`.
 */
function normalizeHostPath(p: string): string {
  if (WIN_ABS_RE.test(p)) {
    const fwd = p.replaceAll('\\', '/').replace(/\/+/g, '/');
    const drive = fwd[0].toLowerCase();
    return `/${drive}${fwd.slice(2)}`;
  }
  return path.normalize(p);
}

/**
 * Host path bind-mounted as the lane workdir (`/work` in agent containers).
 * Must be absolute when Litmus runs inside Docker (see Dockerfile `LITMUS_IN_DOCKER`).
 */
export function resolveWorkHostDirForDocker(): string {
  const raw = process.env.WORK_HOST_DIR;
  const value = raw != null && raw.trim() !== '' ? raw.trim() : './work';
  if (isAbsoluteOnAnyOS(value)) return normalizeHostPath(value);
  if (process.env.LITMUS_IN_DOCKER === '1') {
    requireAbsoluteOnDockerHost(value, 'WORK_HOST_DIR');
  }
  return path.resolve(process.cwd(), value);
}

/**
 * Host directory for one agent vendor, bind-mounted at `/opt/agent`.
 * `agentType` is the vendor directory name under `agents/` (e.g. "cursor", "mock").
 * When set, `AGENTS_HOST_DIR` is the web project root (parent of the `agents` folder).
 */
export function resolveAgentHostDirForDocker(agentType: string): string {
  return joinHostPath(resolveAgentsBaseDir(), 'agents', agentType);
}

/**
 * Host directory for shared scripts (init.sh, tests/), bind-mounted at `/opt/shared`.
 * This is the `agents/` root directory itself.
 */
export function resolveSharedScriptsDirForDocker(): string {
  return joinHostPath(resolveAgentsBaseDir(), 'agents');
}

function resolveAgentsBaseDir(): string {
  const raw = process.env.AGENTS_HOST_DIR;
  if (raw != null && raw.trim() !== '') {
    const value = raw.trim();
    return isAbsoluteOnAnyOS(value)
      ? normalizeHostPath(value)
      : process.env.LITMUS_IN_DOCKER === '1'
        ? requireAbsoluteOnDockerHost(value, 'AGENTS_HOST_DIR')
        : path.resolve(process.cwd(), value);
  }
  return path.resolve(process.cwd());
}
