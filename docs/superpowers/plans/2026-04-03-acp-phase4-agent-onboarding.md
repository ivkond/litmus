# ACP Phase 4: Agent Onboarding + Docker Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install all 6 agent CLIs into the Docker runtime image, verify ACP handshake for each, delete legacy `run.sh` scripts, and document per-agent quirks.

**Architecture:** Single fat image (`litmus/runtime-python`) with all agent binaries. Each agent must pass a smoke test: `AcpSession.start()` → `initialize` handshake succeeds. Node.js 22 added to base image for npm-based agents (Codex, Cline).

**Tech Stack:** Docker, Python 3.12, Node.js 22, curl installers, npm

**Spec:** `docs/superpowers/specs/2026-03-29-acp-integration-design.md` — Phase 4 section

**Depends on:** Phases 1-3 completed (AcpSession, collect, scheduler integration)

---

## Prerequisites Check

**Already done (from Phases 1-3):**
- `LaneConfig.env` exists (`types.ts:204`)
- `POST /api/runs` reads executor secrets and passes `env: mergedEnv` (`runs/route.ts:127`)
- `Scheduler.executeLane` passes `env: lane.env ?? {}` to `executor.start` (`scheduler.ts:149`)

**Required for smoke tests:**
- Docker Desktop running
- `docker compose build litmus-runtime-python` to rebuild image after Dockerfile changes
- API keys for each agent (not committed — set as env vars or in executor config)

---

## Agent Install Matrix

| Agent | Binary | Install method | ACP command | Needs Node.js |
|---|---|---|---|---|
| Cursor | `agent` | Already installed (Dockerfile line 10) | `agent --acp` | No |
| Claude Code | `claude` | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude --acp` | No |
| Codex | `codex` | `npm install -g @openai/codex` | `codex acp` | Yes |
| OpenCode | `opencode` | `curl -fsSL https://opencode.ai/install \| bash` | `opencode acp` | No |
| Cline | `cline` | `npm install -g cline` | `cline --acp` | Yes (v20+) |
| KiloCode | `kilo` | Binary: `kilo-linux-x64-musl.tar.gz` from GitHub Releases | `kilo acp` | No |

> **Cursor binary name discrepancy:** The spec says `cursor agent --acp` with binary `cursor`, but the Dockerfile installs binary `agent` (not `cursor`). The `resolveAcpConfig` entry is `['cursor', 'agent', '--acp']`. Smoke test in Task 3 will determine the correct command — if it's `['agent', '--acp']`, update `resolveAcpConfig` accordingly.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `web/agents/runtime/Dockerfile` | Modify | Install Node.js 22 + all 6 agent CLIs |
| `web/src/lib/orchestrator/scheduler.ts` | Modify (maybe) | Fix `resolveAcpConfig` if smoke tests reveal wrong binary names |
| `web/agents/cursor/run.sh` | Delete | Replaced by ACP in Phase 3 |
| `web/agents/mock/run.sh` | Delete | Replaced by `mock-acp-server.py` in Phase 3 |
| `web/agents/README.md` | Create | Per-agent quirks, ACP commands, required env vars |

---

### Task 1: Update Dockerfile — add Node.js and all agent CLIs

**Files:**
- Modify: `web/agents/runtime/Dockerfile`

- [ ] **Step 1: Write the updated Dockerfile**

Replace the entire content of `web/agents/runtime/Dockerfile`:

```dockerfile
FROM python:3.12-slim

# ── System dependencies ───────────────────────────────────────
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*

# ── Python test tooling ───────────────────────────────────────
RUN pip install --no-cache-dir pytest pytest-json-report

# ── Node.js 22 (needed by Codex + Cline) ─────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Agent CLIs ────────────────────────────────────────────────

# 1. Cursor (https://cursor.com/cli) — installs `agent` binary
RUN curl -fsSL https://cursor.com/install | bash \
    && ln -sf /root/.local/bin/agent /usr/local/bin/agent

# 2. Claude Code (https://code.claude.com) — installs `claude` binary
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude

# 3. Codex (https://github.com/openai/codex) — npm package
RUN npm install -g @openai/codex

# 4. OpenCode (https://opencode.ai) — installs `opencode` binary
RUN curl -fsSL https://opencode.ai/install | bash \
    && ln -sf /root/.local/bin/opencode /usr/local/bin/opencode

# 5. Cline (https://docs.cline.bot) — npm package, requires Node 20+
RUN npm install -g cline

# 6. KiloCode (https://github.com/Kilo-Org/kilocode) — pre-built musl binary for Docker
RUN KILO_VERSION=$(curl -fsSL https://api.github.com/repos/Kilo-Org/kilocode/releases/latest | grep -oP '"tag_name":\s*"\K[^"]+') \
    && curl -fsSL "https://github.com/Kilo-Org/kilocode/releases/download/${KILO_VERSION}/kilo-linux-x64-musl.tar.gz" \
       -o /tmp/kilo.tar.gz \
    && tar -xzf /tmp/kilo.tar.gz -C /usr/local/bin/ kilo \
    && chmod +x /usr/local/bin/kilo \
    && rm /tmp/kilo.tar.gz

WORKDIR /work
CMD ["sleep", "infinity"]
```

> **Notes:**
> - `xz-utils` may be needed by some curl installers that ship xz-compressed archives
> - Each `ln -sf` ensures the binary is in PATH (`/usr/local/bin/`)
> - npm-based installs (Codex, Cline) go to `/usr/local/lib/node_modules/` and are auto-linked to `/usr/local/bin/`
> - KiloCode uses the musl variant for Docker (python:3.12-slim is Debian, not Alpine, but musl binary is more portable; if it fails, switch to `kilo-linux-x64.tar.gz`)
> - Install order doesn't matter — each is independent

- [ ] **Step 2: Build the image**

```bash
cd web && docker compose build litmus-runtime-python
```

Expected: Image builds successfully. Watch for:
- Node.js install succeeds
- Each agent CLI installs without errors
- No `E: Unable to locate package` errors

If any agent install fails, comment it out and proceed — Phase 4 DoD only requires agents that successfully install.

- [ ] **Step 3: Verify all binaries are in PATH**

```bash
docker run --rm litmus/runtime-python sh -c '
  echo "=== Binary check ===" &&
  which agent && agent --version 2>/dev/null || echo "agent: NOT FOUND or no --version" &&
  which claude && claude --version 2>/dev/null || echo "claude: NOT FOUND or no --version" &&
  which codex && codex --version 2>/dev/null || echo "codex: NOT FOUND or no --version" &&
  which opencode && opencode --version 2>/dev/null || echo "opencode: NOT FOUND or no --version" &&
  which cline && cline --version 2>/dev/null || echo "cline: NOT FOUND or no --version" &&
  which kilo && kilo --version 2>/dev/null || echo "kilo: NOT FOUND or no --version" &&
  echo "=== Node.js ===" &&
  node --version &&
  echo "=== Python ===" &&
  python3 --version
'
```

Expected: All 6 binaries found. Node.js v22.x. Python 3.12.x.

- [ ] **Step 4: Commit**

```bash
git add web/agents/runtime/Dockerfile
git commit -m "feat(runtime): install all 6 agent CLIs into Docker image (Node.js 22 + curl + npm + binary)"
```

---

### Task 2: Verify Cursor ACP binary name and fix resolveAcpConfig

**Files:**
- Possibly modify: `web/src/lib/orchestrator/scheduler.ts`

The spec says `cursor agent --acp` (binary: `cursor`), but the Dockerfile installs binary `agent`. We need to determine the correct ACP command.

- [ ] **Step 1: Test Cursor ACP command in container**

```bash
docker run --rm litmus/runtime-python sh -c '
  echo "--- Testing: cursor agent --acp ---" &&
  which cursor 2>/dev/null && echo "cursor binary: FOUND" || echo "cursor binary: NOT FOUND" &&
  echo "--- Testing: agent --acp ---" &&
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-16\"}}" | timeout 5 agent --acp 2>/dev/null || echo "agent --acp: exited $?"
'
```

- [ ] **Step 2: If binary is `agent` (not `cursor`), update resolveAcpConfig**

In `web/src/lib/orchestrator/scheduler.ts`, find the `resolveAcpConfig` method and update the cursor entry:

```typescript
// Before (from spec assumption):
'cursor': { acpCmd: ['cursor', 'agent', '--acp'], requiresAuth: true },

// After (if binary is `agent`):
'cursor': { acpCmd: ['agent', '--acp'], requiresAuth: true },
```

- [ ] **Step 3: Run tests to verify no regression**

```bash
cd web && npx vitest run src/lib/orchestrator/__tests__/scheduler.test.ts
```

Expected: ALL PASS

- [ ] **Step 4: Commit (if changed)**

```bash
git add web/src/lib/orchestrator/scheduler.ts
git commit -m "fix(orchestrator): correct Cursor ACP command to match actual binary name"
```

---

### Task 3: Per-agent ACP smoke tests

**Prerequisite:** Docker image built (Task 1), API keys available as env vars.

For each agent, run an ACP handshake test inside the container. The test: send `initialize` JSON-RPC, expect a valid response. This does NOT require API keys — `initialize` is a local handshake.

- [ ] **Step 1: Smoke test each agent**

Run for each agent (replace `CMD` with the ACP command from `resolveAcpConfig`):

```bash
# Template:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-16","clientInfo":{"name":"litmus","version":"1.0.0"}}}' \
  | timeout 10 docker run --rm -i litmus/runtime-python CMD

# Cursor:
echo '...' | timeout 10 docker run --rm -i litmus/runtime-python agent --acp

# Claude Code:
echo '...' | timeout 10 docker run --rm -i litmus/runtime-python claude --acp

# Codex:
echo '...' | timeout 10 docker run --rm -i litmus/runtime-python codex acp

# OpenCode:
echo '...' | timeout 10 docker run --rm -i litmus/runtime-python opencode acp

# Cline:
echo '...' | timeout 10 docker run --rm -i litmus/runtime-python cline --acp

# KiloCode:
echo '...' | timeout 10 docker run --rm -i litmus/runtime-python kilo acp

# Mock (always works):
echo '...' | timeout 10 docker run --rm -i -v "$(pwd)/agents/mock:/opt/agent:ro" litmus/runtime-python python3 /opt/agent/mock-acp-server.py
```

Expected for each: JSON response containing `"protocolVersion"` and `"agentInfo"`.

- [ ] **Step 2: Record results**

For each agent, note:
- Does `initialize` succeed?
- What is the exact `agentInfo.name` returned?
- Any warnings or stderr output?
- Does the process exit cleanly after stdin closes?

**If an agent fails:** Document the failure. Common issues:
- Binary not found → Dockerfile install failed, fix in Task 1
- `--acp` flag not recognized → Agent doesn't support ACP yet, document in README
- Handshake rejected → Protocol version mismatch, try without `clientInfo`
- Process hangs → No ACP support, stdin not being read

- [ ] **Step 3: Update resolveAcpConfig for any corrections**

If any agent's ACP command differs from what's in `resolveAcpConfig`, update it. Run tests after each change.

- [ ] **Step 4: Commit smoke test results as documentation**

Results go into `web/agents/README.md` (Task 5).

---

### Task 4: Delete legacy run.sh scripts

**Files:**
- Delete: `web/agents/cursor/run.sh`
- Delete: `web/agents/mock/run.sh`

- [ ] **Step 1: Verify run.sh is not referenced anywhere**

```bash
cd web && grep -r 'run\.sh' src/ --include='*.ts' --include='*.tsx'
```

Expected: No references to `run.sh` in TypeScript code (all replaced by AcpSession in Phase 3).

```bash
cd web && grep -r 'run\.sh' agents/ --include='*.sh'
```

Expected: Only `cursor/run.sh` and `mock/run.sh` themselves reference `run.sh` (in their own comments).

- [ ] **Step 2: Delete the files**

```bash
rm web/agents/cursor/run.sh web/agents/mock/run.sh
```

- [ ] **Step 3: Run tests to verify no regression**

```bash
cd web && npx vitest run
```

Expected: ALL PASS — nothing in the test suite references these shell scripts.

- [ ] **Step 4: Commit**

```bash
git add -u web/agents/cursor/run.sh web/agents/mock/run.sh
git commit -m "chore(agents): delete legacy run.sh scripts (replaced by ACP in Phase 3)"
```

---

### Task 5: Document per-agent quirks

**Files:**
- Create: `web/agents/README.md`

- [ ] **Step 1: Write README with smoke test results**

Create `web/agents/README.md`:

```markdown
# Agent Runtime

All agents run inside the `litmus/runtime-python` Docker image. Each agent communicates with the orchestrator via the **Agent Client Protocol (ACP)** — JSON-RPC 2.0 over stdio.

## Image Contents

- **Base:** Python 3.12 (slim)
- **Node.js:** 22.x (for npm-based agents)
- **Test tooling:** pytest, pytest-json-report

## Agent CLIs

| Agent | Binary | ACP Command | Install Method | Required Env Vars |
|---|---|---|---|---|
| Cursor | `agent` | `agent --acp` | curl installer | `CURSOR_API_KEY` |
| Claude Code | `claude` | `claude --acp` | curl installer | `ANTHROPIC_API_KEY` |
| Codex | `codex` | `codex acp` | npm | `OPENAI_API_KEY` |
| OpenCode | `opencode` | `opencode acp` | curl installer | Provider-specific |
| Cline | `cline` | `cline --acp` | npm | Provider-specific |
| KiloCode | `kilo` | `kilo acp` | binary (musl) | Provider-specific |
| Mock | `python3` | `python3 /opt/agent/mock-acp-server.py` | Python stdlib | None |

## Shared Scripts

| Script | Purpose | Protocol |
|---|---|---|
| `init.sh` | Prepare workspace (copy scenario files, install deps) | Shell (via `collect()`) |
| `*/models.sh` | Discover available models for an agent | Shell (via `collect()`) |
| `tests/python.sh` | Run pytest and produce `test-results.json` | Shell (via `collect()`) |

## Per-Agent Quirks

<!-- Fill in after smoke tests -->

### Cursor
- Binary is `agent`, not `cursor` (Cursor CLI installs as `agent`)
- ACP command: `agent --acp`

### Claude Code
- Requires `ANTHROPIC_API_KEY` for prompts (initialize handshake works without it)

### Codex
- Requires Node.js (installed via npm)

### OpenCode
- TBD (pending smoke test)

### Cline
- Requires Node.js 20+ (installed via npm)

### KiloCode
- Uses musl binary for Docker compatibility

## Building the Image

```bash
docker compose build litmus-runtime-python
```

## ACP Integration

The orchestrator uses `AcpSession` (see `src/lib/orchestrator/acp-session.ts`) to manage ACP connections. The `resolveAcpConfig` method in `scheduler.ts` maps `agentType` to ACP launch commands.

Agent type values are set by users when creating agents in the settings UI and stored in `agent_executors.agent_type`.
```

- [ ] **Step 2: Update quirks section after smoke tests**

Replace `TBD` entries with actual findings from Task 3.

- [ ] **Step 3: Commit**

```bash
git add web/agents/README.md
git commit -m "docs(agents): add README with ACP commands, env vars, and per-agent quirks"
```

---

### Task 6: Phase 4 verification

- [ ] **Step 1: Run full test suite**

```bash
cd web && npx vitest run
```

Expected: ALL PASS

- [ ] **Step 2: TypeScript compilation**

```bash
cd web && npx tsc --noEmit
```

Expected: clean

- [ ] **Step 3: Docker image builds**

```bash
cd web && docker compose build litmus-runtime-python
```

Expected: builds successfully with all 6 agents

- [ ] **Step 4: Verify no run.sh references remain**

```bash
grep -r 'run\.sh' web/src/ --include='*.ts' | grep -v node_modules | grep -v '.test.'
```

Expected: no matches (test files may still reference run.sh in assertions — that's fine if they're checking it's NOT called)

---

## Verification Checklist (from spec)

| # | Verification | Task |
|---|---|---|
| 1 | Every agent binary in PATH inside container | Task 1 Step 3 |
| 2 | Every agent completes `initialize` handshake | Task 3 |
| 3 | `resolveAcpConfig` matches actual binary names | Task 2, Task 3 |
| 4 | `cursor/run.sh` and `mock/run.sh` deleted | Task 4 |
| 5 | Per-agent quirks documented | Task 5 |
| 6 | Full test suite passes | Task 6 |

## Risks

| Risk | Mitigation |
|---|---|
| curl installers may fail in Docker (no interactive tty) | Use `bash -s` or check for `--non-interactive` flags |
| Agent CLI version updates break ACP | Pin versions in Dockerfile where possible |
| KiloCode musl binary may not work on Debian-slim | Fall back to glibc variant `kilo-linux-x64.tar.gz` |
| Some agents may not support ACP yet despite docs | Document as "not onboarded" in README, skip in resolveAcpConfig |
| Image size may grow significantly with 6 CLIs | Accept for now — per-agent images are out of scope |
