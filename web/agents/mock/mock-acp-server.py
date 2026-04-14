#!/usr/bin/env python3
"""Minimal ACP JSON-RPC server over stdio for the mock agent.

Replaces mock/run.sh. Copies solution/ files into the workspace on session/prompt,
just like the shell script did.

Uses only Python 3.12 stdlib — no pip dependencies.
"""

import json
import shutil
import sys
import os
from pathlib import Path


def send_response(id, result):
    msg = json.dumps({"jsonrpc": "2.0", "id": id, "result": result})
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def send_notification(method, params):
    msg = json.dumps({"jsonrpc": "2.0", "method": method, "params": params})
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


# Store session cwd for use in prompt handler
_session_cwd = "/work"


def handle_initialize(msg_id, _params):
    auth_methods = [
        {
            "id": "mock-api-key",
            "type": "env_var",
            "description": "Mock API Key",
            "vars": [{"name": "MOCK_API_KEY"}],
        },
        {
            "id": "mock-oauth",
            "type": "agent",
            "description": "Mock OAuth login (device code flow)",
        },
    ]

    send_response(
        msg_id,
        {
            "protocolVersion": "2025-11-16",
            "agentInfo": {"name": "mock-acp", "version": "1.0.0"},
            "capabilities": {},
            "authMethods": auth_methods,
        },
    )


def handle_new_session(msg_id, params):
    global _session_cwd
    _session_cwd = params.get("cwd", "/work")
    # Note: spec says { id: "mock-session" } but SDK NewSessionResponse uses `sessionId`.
    # Using `sessionId` to match the actual protocol.
    send_response(msg_id, {"sessionId": "mock-session"})


def handle_prompt(msg_id, params):
    session_id = params.get("sessionId", "mock-session")
    meta = params.get("_meta", {})
    scenario_dir = meta.get("scenarioDir", "")

    workspace = _session_cwd
    solution_dir = os.path.join(scenario_dir, "solution")

    status_text = "Mock agent: no solution directory found"

    if os.path.isdir(solution_dir):
        project_dir = os.path.join(workspace, "project")
        os.makedirs(project_dir, exist_ok=True)
        for item in os.listdir(solution_dir):
            src = os.path.join(solution_dir, item)
            dst = os.path.join(project_dir, item)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
        status_text = f"Mock agent: copied solution from {solution_dir} to {project_dir}"
    elif not scenario_dir:
        status_text = "Mock agent: no scenarioDir in _meta"

    # Send session/update notification with text content
    send_notification(
        "session/update",
        {
            "sessionId": session_id,
            "updates": [{"type": "text", "text": status_text}],
        },
    )

    send_response(
        msg_id,
        {
            "stopReason": "end_turn",
            "usage": {
                "inputTokens": 10,
                "outputTokens": 5,
                "totalTokens": 15,
            },
        },
    )


def handle_cancel(_params):
    # Notification — no response expected. Exit cleanly per spec.
    sys.exit(0)


def handle_authenticate(msg_id, params):
    """Handle authenticate request by printing a mock OAuth URL to stdout."""
    method_id = params.get("methodId", "unknown")

    print(f"Please visit: https://mock-auth.example.com/device?method={method_id}", flush=True)
    print(f"Enter code: MOCK-1234", flush=True)

    send_response(msg_id, {"status": "authenticated"})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        params = msg.get("params", {})
        msg_id = msg.get("id")

        if method == "initialize":
            handle_initialize(msg_id, params)
        elif method == "session/new":
            handle_new_session(msg_id, params)
        elif method == "session/prompt":
            handle_prompt(msg_id, params)
        elif method == "session/cancel":
            handle_cancel(params)
        elif method == "authenticate":
            handle_authenticate(msg_id, params)
        elif msg_id is not None:
            # Unknown method with id — return error
            sys.stdout.write(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "error": {"code": -32601, "message": f"Method not found: {method}"},
                    }
                )
                + "\n"
            )
            sys.stdout.flush()


if __name__ == "__main__":
    main()
