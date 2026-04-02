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
#    Symlink as `cursor-agent` for cursor-agent-acp adapter compatibility
RUN curl -fsSL https://cursor.com/install | bash \
    && ln -sf /root/.local/bin/agent /usr/local/bin/agent \
    && ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent

# 2. Claude Code (https://code.claude.com) — installs `claude` binary
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude

# 3. Codex (https://github.com/openai/codex) — npm package
RUN npm install -g @openai/codex

# 4. OpenCode (https://opencode.ai) — installs to ~/.opencode/bin/
RUN curl -fsSL https://opencode.ai/install | bash \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode

# 5. Cline (https://docs.cline.bot) — npm package, requires Node 20+
RUN npm install -g cline

# ── ACP adapters (for agents without native --acp flag) ───────

# claude-agent-acp — official ACP wrapper for Claude Code (uses Claude Agent SDK under the hood)
RUN npm install -g @agentclientprotocol/claude-agent-acp

# codex-acp — official ACP wrapper for Codex (by Zed Industries)
RUN npm install -g @zed-industries/codex-acp

# cursor-agent-acp — community ACP adapter for Cursor CLI
RUN npm install -g @blowmage/cursor-agent-acp

# cline-acp — community ACP adapter for Cline
RUN npm install -g cline-acp

# acpx — headless ACP CLI client for debugging (https://github.com/openclaw/acpx)
RUN npm install -g acpx@latest

# 6. KiloCode (https://github.com/Kilo-Org/kilocode) — glibc binary (Debian-based image)
RUN KILO_VERSION=$(curl -fsSL https://api.github.com/repos/Kilo-Org/kilocode/releases/latest | grep -oP '"tag_name":\s*"\K[^"]+') \
    && curl -fsSL "https://github.com/Kilo-Org/kilocode/releases/download/${KILO_VERSION}/kilo-linux-x64.tar.gz" \
       -o /tmp/kilo.tar.gz \
    && tar -xzf /tmp/kilo.tar.gz -C /usr/local/bin/ kilo \
    && chmod +x /usr/local/bin/kilo \
    && rm /tmp/kilo.tar.gz

WORKDIR /work
CMD ["sleep", "infinity"]
