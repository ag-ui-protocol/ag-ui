"""RunAgentInput context/state reaches the model on every run (#3324).

A resumed SDK session, and a reused worker, keep the system prompt they started
with, so the adapter hands context/state to the model through hooks instead:
``UserPromptSubmit`` for a run that submits a prompt, and the first
``PostToolUse`` for a run that only carries a frontend tool result.
"""
from types import SimpleNamespace

import pytest

from ag_ui_claude_sdk import ClaudeAgentAdapter
import ag_ui_claude_sdk.adapter as module


async def fire(hooks, event, **hook_input):
    """Run every callback registered for ``event``; join their additionalContext."""
    added = []
    for matcher in (hooks or {}).get(event, []):
        for hook in matcher.hooks:
            output = await hook({"hook_event_name": event, "session_id": "native", **hook_input},
                                hook_input.get("tool_use_id"), {"signal": None})
            context = (output or {}).get("hookSpecificOutput", {}).get("additionalContext")
            if context:
                added.append(context)
    return "\n".join(added)


def color(value):
    return [{"description": "Favorite color", "value": value}]


def result_message(**kwargs):
    from claude_agent_sdk import ResultMessage
    return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
                         num_turns=1, session_id="native", **kwargs)


def ask(make_input, run_id, value, **kwargs):
    return make_input(run_id=run_id, context=color(value),
                      messages=[{"id": run_id, "role": "user", "content": "What is my favorite color?"}], **kwargs)


@pytest.mark.asyncio
async def test_reused_worker_gets_each_runs_context(monkeypatch, make_input):
    from claude_agent_sdk import SystemMessage
    workers, seen = [], []

    class Worker:
        def __init__(self, thread, options):
            self.options = options
            workers.append(self)
        async def start(self): pass
        async def stop(self): pass
        def is_alive(self): return True
        async def query(self, prompt, session_id):
            yield SystemMessage(subtype="init", data={"session_id": "native"})
            seen.append(await fire(self.options.hooks, "UserPromptSubmit", prompt=prompt))
            yield result_message()

    monkeypatch.setattr(module, "SessionWorker", Worker)
    adapter = ClaudeAgentAdapter("test", options={"system_prompt": "BASE"})
    for run_id, value in [("m1", "red"), ("m2", "green"), ("m3", "blue")]:
        events = [e async for e in adapter.run(ask(make_input, run_id, value))]
        assert events[-1].type == "RUN_FINISHED"

    assert len(workers) == 1
    assert "- Favorite color: red" in seen[0]
    assert "- Favorite color: green" in seen[1]
    assert "- Favorite color: blue" in seen[2]
    assert "Favorite color: red" not in seen[2]
    assert workers[0].options.system_prompt == "BASE"
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_resumed_session_gets_each_runs_context(monkeypatch, make_input):
    from copy import deepcopy
    from claude_agent_sdk import SystemMessage
    import claude_agent_sdk

    class Store:
        value = None
        async def load(self, thread): return deepcopy(self.value)
        async def save(self, thread, binding): self.value = deepcopy(binding)

    seen = []

    class Worker:
        def __init__(self, thread, options): self.options = options
        async def start(self): pass
        async def stop(self): pass
        def is_alive(self): return True
        async def query(self, prompt, session_id):
            yield SystemMessage(subtype="init", data={"session_id": "native"})
            seen.append((self.options.resume, self.options.system_prompt,
                         await fire(self.options.hooks, "UserPromptSubmit", prompt=prompt)))
            yield result_message()

    monkeypatch.setattr(module, "SessionWorker", Worker)
    monkeypatch.setattr(claude_agent_sdk, "get_session_info", lambda *a, **k: SimpleNamespace(session_id="native"))
    async def resolve(profile): return {}
    adapter = ClaudeAgentAdapter("test", options={"system_prompt": "BASE"}, session_binding_store=Store(),
                                 resolve_profile=resolve, execution_profile="profile")
    for run_id, value in [("m1", "red"), ("m2", "green")]:
        events = [e async for e in adapter.run(ask(make_input, run_id, value))]
        assert events[-1].type == "RUN_FINISHED"

    assert [resume for resume, _, _ in seen] == [None, "native"]
    assert [prompt for _, prompt, _ in seen] == ["BASE", "BASE"]
    assert "- Favorite color: red" in seen[0][2]
    assert "- Favorite color: green" in seen[1][2]
    assert "Favorite color: red" not in seen[1][2]
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_frontend_tool_result_only_run_gets_context(monkeypatch, make_input):
    from mcp import ClientSession
    import httpx
    from mcp.client.streamable_http import streamable_http_client
    from claude_agent_sdk import AssistantMessage, SystemMessage, ToolResultBlock, ToolUseBlock, UserMessage
    import claude_agent_sdk

    call = {"id": "confirm-call", "name": "mcp__ag_ui__confirm", "input": {}}
    confirm = {"name": "confirm", "description": "Confirm", "parameters": {"type": "object", "properties": {}}}
    delivered, prompts = [], []

    class Worker:
        def __init__(self, thread, options): self.options = options
        async def start(self): pass
        async def stop(self): pass
        def is_alive(self): return True
        async def query(self, prompt, session_id):
            prompts.append(prompt)
            yield SystemMessage(subtype="init", data={"session_id": "native"})
            pre_tool_use = self.options.hooks["PreToolUse"][-1].hooks[0]
            hook_input = {"hook_event_name": "PreToolUse", "tool_name": call["name"],
                          "tool_use_id": call["id"], "tool_input": {}}
            if not self.options.resume:
                delivered.append(await fire(self.options.hooks, "UserPromptSubmit", prompt=prompt))
                await pre_tool_use(hook_input, call["id"], {})
                yield AssistantMessage(content=[ToolUseBlock(id=call["id"], name=call["name"], input={})], model="m")
                yield result_message(stop_reason="tool_deferred", deferred_tool_use=call)
                return
            # The SDK replays the deferred call; no user prompt is submitted, so
            # UserPromptSubmit never fires on this run.
            decision = await pre_tool_use(hook_input, call["id"], {})
            assert decision["hookSpecificOutput"]["permissionDecision"] == "allow"
            server = self.options.mcp_servers["ag_ui"]
            async with httpx.AsyncClient(headers=server["headers"]) as http:
                async with streamable_http_client(server["url"], http_client=http) as (read, write, _):
                    async with ClientSession(read, write) as client:
                        await client.initialize()
                        result = await client.call_tool("confirm", {})
            delivered.append(await fire(self.options.hooks, "PostToolUse", tool_name=call["name"],
                                        tool_use_id=call["id"], tool_input={},
                                        tool_response=result.model_dump()["content"]))
            yield UserMessage(content=[ToolResultBlock(tool_use_id=call["id"], content=result.content[0].text,
                                                       is_error=False)])
            yield result_message()

    monkeypatch.setattr(module, "SessionWorker", Worker)
    monkeypatch.setattr(claude_agent_sdk, "get_session_info", lambda *a, **k: SimpleNamespace(session_id="native"))
    adapter = ClaudeAgentAdapter("test")
    first = [e async for e in adapter.run(ask(make_input, "m1", "red", tools=[confirm]))]
    assert first[-1].outcome.pending_tool_call_ids == [call["id"]]

    second = [e async for e in adapter.run(make_input(run_id="r2", context=color("blue"), tools=[confirm], messages=[
        {"id": "m1", "role": "user", "content": "What is my favorite color?"},
        {"id": "assistant", "role": "assistant", "toolCalls": [
            {"id": call["id"], "type": "function", "function": {"name": "confirm", "arguments": "{}"}}]},
        {"id": "result", "role": "tool", "toolCallId": call["id"], "content": "confirmed"},
    ]))]

    assert [e for e in second if e.type == "RUN_ERROR"] == []
    assert second[-1].type == "RUN_FINISHED"
    assert prompts[1] is None
    assert "- Favorite color: red" in delivered[0]
    assert "- Favorite color: blue" in delivered[1]
    await adapter.shutdown()


class TestBuildOptions:
    def test_string_system_prompt_left_as_configured(self, make_input):
        opts = ClaudeAgentAdapter("t", options={"system_prompt": "BASE"}).build_options(
            make_input(state={"count": 1}, context=color("red")))
        assert opts.system_prompt == "BASE"

    def test_preset_system_prompt_left_as_configured(self, make_input):
        preset = {"type": "preset", "preset": "claude_code", "append": "Be brief."}
        opts = ClaudeAgentAdapter("t", options={"system_prompt": dict(preset)}).build_options(
            make_input(state={"count": 1}, context=color("red")))
        assert opts.system_prompt == preset

    @pytest.mark.asyncio
    async def test_context_and_state_delivered_once_per_run(self, make_input):
        opts = ClaudeAgentAdapter("t").build_options(make_input(state={"count": 1}, context=color("red")))
        context = await fire(opts.hooks, "UserPromptSubmit", prompt="q")
        assert "## Context from the application" in context
        assert "- Favorite color: red" in context
        assert '"count": 1' in context
        assert await fire(opts.hooks, "PostToolUse", tool_name="Read", tool_use_id="t") == ""
        assert await fire(opts.hooks, "UserPromptSubmit", prompt="again") == ""

    def test_caller_hooks_kept(self, make_input):
        from claude_agent_sdk import HookMatcher
        async def own(*args): return {}
        opts = ClaudeAgentAdapter("t", options={"hooks": {
            "UserPromptSubmit": [HookMatcher(hooks=[own])],
            "PostToolUse": [HookMatcher(matcher="Read", hooks=[own])],
        }}).build_options(make_input(context=color("red")))
        assert opts.hooks["UserPromptSubmit"][0].hooks == [own]
        assert opts.hooks["PostToolUse"][0].matcher == "Read"
        assert len(opts.hooks["UserPromptSubmit"]) == 2
        assert len(opts.hooks["PostToolUse"]) == 2
