# Agent Runtime

All agents run inside the `litmus/runtime-python` Docker image. Each agent communicates with the orchestrator via the **Agent Client Protocol (ACP)** — JSON-RPC 2.0 over stdio.

## Image Contents

- **Base:** Python 3.12 (slim)
- **Node.js:** 22.x (for npm-based agents)
- **Test tooling:** pytest, pytest-json-report

## Agent CLIs

| Agent | Binary | ACP Command | ACP Method | Required Env Vars |
|---|---|---|---|---|
| Cursor | `agent` + `cursor-agent-acp` | `cursor-agent-acp` | Adapter (@blowmage/cursor-agent-acp) | `CURSOR_API_KEY` |
| Claude Code | `claude` + `claude-agent-acp` | `claude-agent-acp` | Adapter (@agentclientprotocol/claude-agent-acp) | `ANTHROPIC_API_KEY` |
| Codex | `codex` + `codex-acp` | `codex-acp` | Adapter (@zed-industries/codex-acp) | `OPENAI_API_KEY` |
| OpenCode | `opencode` | `opencode acp` | Native | Provider-specific |
| Cline | `cline` | `cline --acp` | Native (partial) | Provider-specific |
| KiloCode | `kilo` | `kilo acp` | Native | Provider-specific |
| Mock | `python3` | `python3 /opt/agent/mock-acp-server.py` | Custom | None |

## Shared Scripts

| Script | Purpose | Protocol |
|---|---|---|
| `init.sh` | Prepare workspace (copy scenario files, install deps) | Shell (via `collect()`) |
| `*/models.sh` | Discover available models for an agent | Shell (via `collect()`) |
| `tests/python.sh` | Run pytest and produce `test-results.json` | Shell (via `collect()`) |

## ACP Smoke Test Results (2026-04-03)

| Agent | ACP Command | Handshake | Notes |
|---|---|---|---|
| Cursor | `cursor-agent-acp` | ⚠️ Starts, needs API key | Adapter finds binary, loads models, hangs on `status` without credentials |
| Claude Code | `claude-agent-acp` | ✅ Handshake OK | Official adapter by ACP maintainers, v0.24.2 |
| Codex | `codex-acp` | ✅ Handshake OK | Official adapter by Zed Industries, v0.11.1 |
| OpenCode | `opencode acp` | ✅ Handshake OK | Native ACP, `protocolVersion` must be numeric (1) |
| Cline | `cline --acp` | ⚠️ Partial | cline-acp adapter incompatible with cline v2.13 (`--output-format` flag removed) |
| KiloCode | `kilo acp` | ✅ Handshake OK | Native ACP, `protocolVersion` must be numeric (1) |
| Mock | `python3 .../mock-acp-server.py` | ✅ Handshake OK | Always works (Python stdlib) |

**Fully onboardable (handshake confirmed):** Claude Code, Codex, OpenCode, KiloCode, Mock.
**Needs API key to fully verify:** Cursor (adapter starts, binary found).
**Pending adapter fix:** Cline (cline-acp v0.1.6 incompatible with cline CLI v2.13).

## Per-Agent Quirks

### Cursor
- Binary is `agent`, not `cursor`; symlinked as `cursor-agent` for adapter
- ACP via `cursor-agent-acp` adapter (@blowmage/cursor-agent-acp v0.7.1)
- Adapter expects `cursor-agent` binary in PATH (symlink added in Dockerfile)
- Needs `CURSOR_API_KEY` — adapter hangs on `cursor-agent status` without it

### Claude Code
- ACP via `claude-agent-acp` adapter (official, @agentclientprotocol/claude-agent-acp v0.24.2)
- Uses Claude Agent SDK under the hood (not the `claude` CLI directly)
- Handshake works without API key; prompts need `ANTHROPIC_API_KEY`

### Codex
- ACP via `codex-acp` adapter (official, @zed-industries/codex-acp v0.11.1)
- Supports `OPENAI_API_KEY` and `CODEX_API_KEY` env vars
- Zero dependencies (4.5kB package) — thin wrapper over codex CLI

### OpenCode
- ✅ Native ACP — `opencode acp`
- Runs one-time SQLite migration on first use (adds ~2s startup)
- `protocolVersion` must be numeric (`1`), not string
- Installed to `~/.opencode/bin/`, symlinked to `/usr/local/bin/`

### Cline
- Native `cline --acp` partially works but times out after param validation
- `cline-acp` adapter (v0.1.6) incompatible with cline CLI v2.13 (`--output-format` flag removed)
- **Blocked** until either cline native ACP stabilizes or cline-acp is updated

### KiloCode
- ✅ Native ACP — `kilo acp`
- Uses pre-built glibc binary (Debian-based image)
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

## acpx

[acpx](https://github.com/openclaw/acpx) (v0.4.0) is installed as a headless ACP CLI client for manual testing and debugging. It provides session persistence, queue-based IPC, and auto-reconnect on top of ACP.

**Usage:** `acpx <agent> "prompt"` or `acpx --agent <command> "prompt"`

Note: acpx is an ACP **consumer** (like our `AcpSession`), not an adapter. Agents must natively support ACP. It auto-downloads community adapter packages (e.g. `claude-agent-acp`, `codex-acp`) on first use if available.

## ACP Integration

The orchestrator uses `AcpSession` (`src/lib/orchestrator/acp-session.ts`) to manage ACP connections per lane. The `resolveAcpConfig` method in `scheduler.ts` maps `agentType` → ACP launch command.

Agent type values are set when creating agents in the settings UI and stored in `agent_executors.agent_type`.
