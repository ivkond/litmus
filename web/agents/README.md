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

### Cursor
- Binary is `agent`, not `cursor` (Cursor CLI installs as `agent`)
- ACP command: `agent --acp` (not `cursor agent --acp`)

### Claude Code
- Requires `ANTHROPIC_API_KEY` for prompts (initialize handshake works without it)
- Installed via native curl installer (no Node.js dependency)

### Codex
- Requires Node.js (installed via npm globally)
- `OPENAI_API_KEY` required

### OpenCode
- Installed via native curl installer
- Env vars depend on configured provider

### Cline
- Requires Node.js 20+ (installed via npm globally)
- Env vars depend on configured provider

### KiloCode
- Uses pre-built musl binary for Docker compatibility
- Downloaded from GitHub Releases (latest version at build time)

### Mock
- Python 3.12 stdlib only — no external dependencies
- Copies `solution/` files into workspace (simulates agent work)
- Lives at `web/agents/mock/mock-acp-server.py`, bind-mounted to `/opt/agent/`

## Building the Image

```bash
docker compose build litmus-runtime-python
```

## ACP Integration

The orchestrator uses `AcpSession` (`src/lib/orchestrator/acp-session.ts`) to manage ACP connections per lane. The `resolveAcpConfig` method in `scheduler.ts` maps `agentType` → ACP launch command.

Agent type values are set when creating agents in the settings UI and stored in `agent_executors.agent_type`.
