"""Actual native SDK over localhost, with an independently restarted provider."""
import asyncio
from dataclasses import asdict
import json
import sys
from pathlib import Path

import pytest
from anthropic import AsyncAnthropic
from ag_ui_claude_managed_agents import ManagedAgentsAgent, InMemorySessionStore, SessionBinding, SessionRecord
from .test_agent import base_input

@pytest.mark.parametrize("language", ["ts", "py", "dotnet"])
async def test_native_http_result_after_provider_restart(language):
    root = Path(__file__).parents[2]
    row = json.loads((root / "fixtures/child-results.json").read_text())[language]
    native = next(e for e in row["native"] if e["type"] == "agent.tool_result")
    store = InMemorySessionStore()
    for completed in [False, True]:
        if completed:
            snapshot = json.dumps(asdict(store.get("1:a|0:|1:e|0:|thread_1")))
            store = InMemorySessionStore()
            store.set("1:a|0:|1:e|0:|thread_1", SessionRecord(**json.loads(snapshot)))
        provider = await asyncio.create_subprocess_exec(sys.executable, str(root / "tests/result_provider.py"), language, *(["completed"] if completed else []), stdout=asyncio.subprocess.PIPE)
        try:
            port = int(await asyncio.wait_for(provider.stdout.readline(), 5))
            async with AsyncAnthropic(api_key="local-test", base_url=f"http://127.0.0.1:{port}", max_retries=0) as client:
                agent = ManagedAgentsAgent(managed_agent_id="a", environment_id="e", client=client, session_store=store, resolve_session=lambda _: SessionBinding("native"))
                value = base_input(messages=[], resume=None if completed else [{"interruptId": row["root"][0]["id"], "status": "resolved", "payload": row["root"][1]["result"]}])
                events = [e async for e in agent.run(value)]
                assert events[-1].type == "RUN_FINISHED"
                results = [e for e in events if e.type == "TOOL_CALL_RESULT"]
                if completed:
                    assert results == []
                else:
                    assert len(results) == 1
                    result = results[0]
                    assert result.message_id == native["id"]
                    assert result.tool_call_id == native["tool_use_id"]
                    assert (json.loads(result.content) if native["is_error"] else result.content) == ({"error": True, "content": native["content"][0]["text"]} if native["is_error"] else native["content"][0]["text"])
        finally:
            if provider.returncode is None:
                provider.terminate()
            await asyncio.wait_for(provider.wait(), 5)
