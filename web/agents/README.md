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

## ACP Smoke Test Results (2026-04-03)

| Agent | Version | ACP Handshake | Notes |
|---|---|---|---|
| Cursor | 2026.03.30 | ❌ `unknown option '--acp'` | ACP not yet in stable CLI |
| Claude Code | 2.1.90 | ❌ `unknown option '--acp'` | ACP not yet in stable CLI |
| Codex | 0.118.0 | ❌ `stdin is not a terminal` | No `acp` subcommand |
| OpenCode | 1.3.13 | ✅ Handshake OK | `protocolVersion` must be numeric (1), not string |
| Cline | 2.13.0 | ⚠️ Partial | Accepts `--acp`, validates params, but times out after handshake |
| KiloCode | 7.1.20 | ✅ Handshake OK | `protocolVersion` must be numeric (1), not string |
| Mock | 1.0.0 | ✅ Handshake OK | Always works (Python stdlib) |

**Currently onboardable via ACP:** OpenCode, KiloCode, Mock.
**Pending ACP support in stable releases:** Cursor, Claude Code, Codex, Cline.

## Per-Agent Quirks

### Cursor
- Binary is `agent`, not `cursor` (Cursor CLI installs as `agent`)
- ACP command: `agent --acp` — **not yet supported** (v2026.03.30)
- Stable CLI uses `agent --print` mode (non-ACP, stdout-based)

### Claude Code
- ACP command: `claude --acp` — **not yet supported** (v2.1.90)
- Installed via native curl installer (no Node.js dependency)
- Requires `ANTHROPIC_API_KEY` for prompts

### Codex
- ACP command: `codex acp` — **not yet supported** (v0.118.0)
- Requires Node.js (installed via npm globally)
- `OPENAI_API_KEY` required

### OpenCode
- ✅ ACP ready — `opencode acp` works
- Runs one-time SQLite migration on first use (adds ~2s startup)
- `protocolVersion` must be numeric (`1`), not string (`"2025-11-16"`)
- Installed via native curl installer to `~/.opencode/bin/`

### Cline
- ACP command: `cline --acp` — **partial support** (v2.13.0)
- Accepts ACP mode, validates JSON-RPC params, but times out after init
- `protocolVersion` must be numeric
- Requires Node.js 20+

### KiloCode
- ✅ ACP ready — `kilo acp` works
- Uses pre-built glibc binary (not musl — Debian-based image needs glibc)
- Runs one-time SQLite migration on first use (adds ~2s startup)
- `protocolVersion` must be numeric (`1`), not string

### Mock
- Python 3.12 stdlib only — no external dependencies
- Copies `solution/` files into workspace (simulates agent work)
- Lives at `web/agents/mock/mock-acp-server.py`, bind-mounted to `/opt/agent/`
- Accepts string `protocolVersion` (matches SDK constant `"2025-11-16"`)

## Building the Image

```bash
docker compose build litmus-runtime-python
```

## ACP Integration

The orchestrator uses `AcpSession` (`src/lib/orchestrator/acp-session.ts`) to manage ACP connections per lane. The `resolveAcpConfig` method in `scheduler.ts` maps `agentType` → ACP launch command.

Agent type values are set when creating agents in the settings UI and stored in `agent_executors.agent_type`.
