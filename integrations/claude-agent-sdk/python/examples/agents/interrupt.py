"""Interrupt / resume agent configuration (AG-UI interrupt contract).

Demonstrates the ``defer``-based interrupt bridge:

1. The model calls the backend ``delete_file`` tool.
2. A PreToolUse hook returns ``permissionDecision: "defer"`` the first time it
   sees a given tool call, so the run halts at the tool boundary. The adapter
   (constructed with ``emit_interrupt_outcome=True``) turns the resulting
   ``DeferredToolUse`` into a ``RunFinishedInterruptOutcome`` — the frontend
   receives ``outcome: {type: "interrupt", interrupts: [...]}`` with a
   ``response_schema`` it can render as an approval form.
3. The user resolves the interrupt; the client sends the next request with
   ``resume: [{interrupt_id, status: "resolved"|"cancelled", payload}]`` on the
   same ``thread_id``.
4. The persisted Claude session continues; the SAME frozen tool call re-fires
   the PreToolUse hook. The hook reads the adapter's resume verdict:
   ``resolved`` -> ``allow`` (with the frozen args), otherwise ``deny``.

Enforcement lives in the hook, not the prompt: the model cannot execute the
gated tool until a real resume verdict exists, and the executed args stay bound
to the frozen ``DeferredToolUse.input`` (resume carries only the verdict).
"""

import json
from typing import Any

from claude_agent_sdk import tool, create_sdk_mcp_server, HookMatcher
from ag_ui_claude_sdk import ClaudeAgentAdapter
from ag_ui_claude_sdk.interrupts import tool_use_id_from_interrupt_id  # noqa: F401  (documents the id mapping)
from .constants import DEFAULT_DISALLOWED_TOOLS

GATED_TOOL = "delete_file"


@tool(GATED_TOOL, "Delete a file at the given path", {"path": str})
async def delete_file(args: dict[str, Any]) -> dict[str, Any]:
    """Mock destructive tool — only runs after the interrupt is resolved."""
    path = args.get("path", "")
    return {"content": [{"type": "text", "text": f"Deleted {path}"}], "path": path}


file_ops_server = create_sdk_mcp_server("file_ops", "1.0.0", tools=[delete_file])


def create_interrupt_adapter() -> ClaudeAgentAdapter:
    """Create adapter for the interrupt/resume demo."""
    adapter = ClaudeAgentAdapter(
        name="interrupt",
        description="Destructive tool gated behind an AG-UI interrupt",
        emit_interrupt_outcome=True,
        options={
            "model": "claude-haiku-4-5",
            "system_prompt": (
                "You help with file operations. When asked to delete a file, "
                f"call the {GATED_TOOL} tool with the path. The deletion is "
                "gated behind human approval; just make the call and let the "
                "approval flow handle the rest."
            ),
            "mcp_servers": {"file_ops": file_ops_server},
            "allowed_tools": [f"mcp__file_ops__{GATED_TOOL}"],
            "disallowed_tools": list(DEFAULT_DISALLOWED_TOOLS),
        },
    )

    async def gate_hook(input_data: dict, tool_use_id: str, context: Any) -> dict:
        """PreToolUse hook: defer the gated tool until a resume verdict exists.

        The adapter records resume verdicts per thread keyed by the deferred
        tool-use id. On the resumed run the same tool_use_id re-fires here, so
        we look it up and allow (frozen args) or deny.
        """
        tool_name = input_data.get("tool_name", "")
        if not tool_name.endswith(GATED_TOOL):
            return {}

        thread_id = getattr(context, "session_id", None) or getattr(context, "thread_id", "")
        verdict = adapter.resume_verdict_for(thread_id, tool_use_id)

        if verdict is None:
            # First sighting — pause the run and surface the interrupt.
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "defer"}}

        if verdict["resolved"]:
            # Approved: run the frozen call exactly as proposed.
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}

        # Cancelled: refuse the call; the model is told and can respond.
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "User declined the file deletion.",
            }
        }

    # Register the gate on the adapter's base options so every run carries it.
    opts = adapter._options or {}
    if isinstance(opts, dict):
        hooks = opts.setdefault("hooks", {})
        hooks["PreToolUse"] = [HookMatcher(hooks=[gate_hook])]

    return adapter
