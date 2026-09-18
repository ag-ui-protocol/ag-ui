"""Live declaration-only tool gate; never records prompts, tokens, or raw events."""

import argparse
import asyncio
import json
import os
import secrets
from pathlib import Path

from copilot import CopilotClient
from copilot.rpc import HandlePendingToolCallRequest, PermissionDecisionUserNotAvailable
from copilot.tools import Tool


async def main(parallel: bool = False) -> None:
    storage = Path(".runtime").resolve()
    storage.mkdir(exist_ok=True)
    client = CopilotClient(
        use_logged_in_user=True, log_level="error", mode="empty", base_directory=str(storage)
    )
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    session = None
    nonce = secrets.token_hex(12)
    count = 2 if parallel else 1
    names = ["browser_left", "browser_right"] if parallel else ["browser_nonce"]
    pending = []
    summary = {"sdk": "1.0.14", "model": os.getenv("COPILOT_MODEL", "auto")}
    try:
        await client.start()
        session = await client.create_session(
            model=summary["model"],
            on_permission_request=lambda *_: PermissionDecisionUserNotAvailable(),
            on_event=queue.put_nowait,
            streaming=True,
            available_tools=names,
            tools=[
                Tool(
                    name=name,
                    description="Return a fresh nonce provided by the browser.",
                    parameters={"type": "object", "properties": {}, "additionalProperties": False},
                    skip_permission=True,
                )
                for name in names
            ],
            enable_config_discovery=False,
            enable_on_demand_instruction_discovery=False,
            enable_file_hooks=False,
            enable_host_git_operations=False,
            enable_session_store=False,
            enable_skills=False,
        )
        await session.send(
            "Call browser_left AND browser_right exactly once each, together in one parallel "
            "tool batch BEFORE waiting for either result. Then repeat both returned values verbatim."
            if parallel
            else "Call browser_nonce exactly once, then repeat the returned nonce verbatim."
        )
        types: set[str] = set()
        final = ""
        requested = resolved = 0
        async with asyncio.timeout(120):
            while True:
                event = (await queue.get()).to_dict()
                kind, data = event["type"], event["data"]
                types.add(kind)
                if kind == "external_tool.requested":
                    assert data["toolName"] in names
                    requested += 1
                    pending.append(data)
                    if len(pending) == count:
                        for request in reversed(pending):
                            result = await session.rpc.tools.handle_pending_tool_call(
                                HandlePendingToolCallRequest(
                                    request_id=request["requestId"], result=nonce
                                )
                            )
                            assert result.success
                            resolved += 1
                elif kind == "assistant.message":
                    final += data.get("content", "")
                elif kind == "session.error":
                    raise RuntimeError("Native session.error (raw details deliberately omitted)")
                elif kind == "session.idle" and resolved:
                    break
        assert requested == resolved == count
        assert nonce in final, "Original conversation did not consume the external result"
        summary.update(
            passed=True,
            declaration_only=True,
            session_send_calls=1,
            pending_requests=requested,
            typed_rpc_successes=resolved,
            original_assistant_used_nonce=True,
            parallel_requests_resolved_out_of_order=parallel,
            event_types=sorted(types),
        )
        print(json.dumps(summary, indent=2))
    finally:
        if session:
            await session.abort()
            await session.disconnect()
        try:
            await client.stop()
        except Exception:  # noqa: BLE001 -- force-stop is SDK's documented shutdown fallback.
            await client.force_stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--parallel", action="store_true")
    asyncio.run(main(parser.parse_args().parallel))
