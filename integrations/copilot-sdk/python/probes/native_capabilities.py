"""Opt-in live runtime shell/subagent capability probe, NEVER exposed over HTTP.

Shell execution is exact-command allowlisted in both hook and permission callback.
All records are shape/capability summaries, not raw prompts, reasoning, or tool logs.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path

from copilot import CopilotClient
from copilot.rpc import PermissionDecisionApproveOnce, PermissionDecisionUserNotAvailable

from ag_ui_copilot_sdk import EventMapper

COMMANDS = {
    "success": "printf 'native-one\\n'; sleep 0.2; printf 'native-two\\n'",
    "failure": "printf 'native-failure\\n'; exit 7",
    "cancel": "printf 'native-cancel\\n'; sleep 20; printf 'should-not-finish\\n'",
}


async def probe(client, scenario):
    queue = asyncio.Queue(maxsize=2048)
    subagent = scenario == "subagent"
    command = COMMANDS.get(scenario)

    def permission(request, _):
        if getattr(request, "full_command_text", None) == command and command:
            return PermissionDecisionApproveOnce()
        return PermissionDecisionUserNotAvailable()

    def pre_tool(data, _):
        args = data["toolArgs"]
        if subagent:
            report["tool_argument_keys"] = sorted(args)
            report["requested_agent"] = args.get("agent_type")
        safe_shell = data["toolName"] == "bash" and args.get("command") == command and command
        safe_child = (
            subagent and data["toolName"] == "task" and args.get("agent_type") == "nonce-child"
        )
        return {"permissionDecision": "allow" if safe_shell or safe_child else "deny"}

    kwargs = {}
    if subagent:
        kwargs["custom_agents"] = [
            {
                "name": "nonce-child",
                "description": "Compute the harmless sum 2+3 without any tools.",
                "prompt": "Compute 2+3 and answer 5. No tools, files, network, or shell.",
                # A child needs an available model; a root request can silently fall back.
                "tools": [],
                "model": os.getenv("COPILOT_MODEL", "gpt-5.4-mini"),
            }
        ]
    session = await client.create_session(
        model=os.getenv("COPILOT_MODEL", "auto"),
        on_event=queue.put_nowait,
        streaming=True,
        include_sub_agent_streaming_events=True,
        available_tools=["builtin:task"] if subagent else ["builtin:bash"],
        hooks={"on_pre_tool_use": pre_tool},
        on_permission_request=permission,
        enable_config_discovery=False,
        enable_skills=False,
        enable_file_hooks=False,
        enable_host_git_operations=False,
        enable_session_store=False,
        **kwargs,
    )
    report = {"scenario": scenario, "event_types": [], "partial_output_events": 0, "tool_calls": 0}
    mapper = EventMapper(max_items=8000)
    kinds = set()
    mapped = set()
    try:
        await session.send(
            "Use task to invoke agent_type nonce-child synchronously to compute 2+3. "
            "Actually invoke the custom child agent, then report its result."
            if subagent
            else f"Invoke bash exactly once with this exact command (do not modify it): {command}\n"
            "Do not retry on failure. Report the observed result."
        )
        async with asyncio.timeout(180):
            while True:
                raw = (await queue.get()).to_dict()
                kind, data = raw["type"], raw["data"]
                kinds.add(kind)
                for event in mapper.map_event(raw):
                    mapped.add(event.type.value)
                if kind == "tool.execution_start":
                    report["tool_calls"] += 1
                    report["shell_display_command"] = "displayCommand" in (
                        data.get("shellToolInfo") or {}
                    )
                    if scenario == "cancel":
                        await asyncio.sleep(0.3)
                        await session.abort()
                        report["abort_returned"] = True
                if kind == "tool.execution_partial_result":
                    report["partial_output_events"] += 1
                if kind == "tool.execution_complete":
                    report["tool_success"] = data["success"]
                    report["exit_code"] = (data.get("shellExecution") or {}).get("exitCode")
                    if subagent and not data["success"]:
                        report["error_code"] = (data.get("error") or {}).get("code")
                if kind == "subagent.started":
                    report["real_subagent_started"] = True
                    report["relationship_fields"] = {
                        "envelope_agentId": bool(raw.get("agentId")),
                        "data_toolCallId": bool(data.get("toolCallId")),
                        "data_parentId": bool(data.get("parentId")),
                        "agentId_equals_toolCallId": raw.get("agentId") == data.get("toolCallId"),
                    }
                if kind.startswith("assistant.reasoning"):
                    report["readable_reasoning_emitted"] = bool(
                        data.get("content") or data.get("deltaContent")
                    )
                if raw.get("agentId"):
                    report["child_scoped_events"] = report.get("child_scoped_events", 0) + 1
                if kind == "session.error":
                    report["session_error"] = True
                    break
                if kind == "session.idle":
                    break
        report["event_types"] = sorted(kinds)
        report["mapped_types"] = sorted(mapped)
        report["completed"] = True
    except TimeoutError:
        report["completed"] = False
        report["limitation"] = "Runtime did not reach idle within probe deadline"
        report["event_types"] = sorted(kinds)
    finally:
        await session.abort()
        await session.disconnect()
    return report


async def main(scenario=None):
    storage = Path(".runtime").resolve()
    storage.mkdir(exist_ok=True)
    client = CopilotClient(
        mode="empty", base_directory=str(storage), use_logged_in_user=True, log_level="error"
    )
    try:
        await client.start()
        reports = []
        for selected in [scenario] if scenario else ("success", "failure", "cancel", "subagent"):
            report = await probe(client, selected)
            reports.append(report)
            print(json.dumps(report), flush=True)
        Path(
            f"probes/native-{'subagent' if len(reports) == 1 else 'capabilities'}.evidence.json"
        ).write_text(
            json.dumps(
                {
                    "sdk": "1.0.14",
                    "runtime": "1.0.85",
                    "model": os.getenv("COPILOT_MODEL", "auto"),
                    "probes": reports,
                    "child_model": os.getenv("COPILOT_MODEL", "gpt-5.4-mini"),
                },
                indent=2,
            )
            + "\n"
        )
    finally:
        try:
            await client.stop()
        except Exception:  # noqa: BLE001
            await client.force_stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=["success", "failure", "cancel", "subagent"])
    asyncio.run(main(parser.parse_args().scenario))
