"""Structured system prompts survive thread creation without sharing state."""

from copy import deepcopy
from types import SimpleNamespace

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from ag_ui_strands import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig
from strands import Agent
from strands.models.model import Model
from strands.tools.registry import ToolRegistry

BLOCKS = [
    {"text": "Static instructions."},
    {"cachePoint": {"type": "default", "ttl": "5m"}},
    {"text": "Dynamic context."},
]


class RecordingModel(Model):
    def __init__(self):
        self.prompts = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise AssertionError("this test only streams text")
        yield  # pragma: no cover

    async def stream(
        self,
        messages,
        tool_specs=None,
        system_prompt=None,
        *,
        system_prompt_content=None,
        **kwargs,
    ):
        self.prompts.append(deepcopy(system_prompt_content))
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": "ok"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


async def run(adapter, thread_id="a"):
    run_input = RunAgentInput(
        thread_id=thread_id,
        run_id="r",
        state={},
        tools=[],
        context=[],
        forwarded_props={},
        messages=[UserMessage(id="u", content="hi")],
    )
    events = [event async for event in adapter.run(run_input)]
    assert not [event for event in events if event.type == EventType.RUN_ERROR]
    assert events[-1].type == EventType.RUN_FINISHED
    return adapter._agents_by_thread[thread_id]


@pytest.mark.parametrize(
    "prompt",
    [
        None,
        "",
        [],
        "Plain text",
        [{"text": "First"}, {"text": "Second"}],
        BLOCKS,
        [{"cachePoint": {"type": "default"}}],
        [*BLOCKS, {"cachePoint": {"type": "default", "ttl": "5m"}}],
    ],
    ids=[
        "none",
        "empty-string",
        "empty-list",
        "plain-text",
        "multi-text",
        "middle-checkpoint-ttl",
        "cache-only",
        "multiple-checkpoints",
    ],
)
@pytest.mark.asyncio
async def test_model_receives_canonical_system_blocks(prompt):
    model = RecordingModel()
    template = Agent(model=model, system_prompt=deepcopy(prompt), callback_handler=None)
    expected = deepcopy(template.system_prompt_content)
    adapter = StrandsAgent(template, name="test")

    thread = await run(adapter)

    assert model.prompts == [expected]
    assert thread.system_prompt == template.system_prompt
    assert thread.model is model


@pytest.mark.asyncio
async def test_prompt_is_a_value_snapshot_at_wrap_time():
    source = deepcopy(BLOCKS)
    model = RecordingModel()
    template = Agent(model=model, system_prompt=source, callback_handler=None)
    adapter = StrandsAgent(template, name="test")
    source[0]["text"] = "changed template"
    source[1]["cachePoint"]["ttl"] = "1h"
    source.append({"text": "new template block"})
    template.system_prompt = "replacement template prompt"

    await run(adapter)

    assert model.prompts == [BLOCKS]


@pytest.mark.asyncio
async def test_threads_do_not_share_prompt_blocks_and_cached_threads_are_reused():
    model = RecordingModel()
    template = Agent(model=model, system_prompt=deepcopy(BLOCKS), callback_handler=None)
    adapter = StrandsAgent(template, name="test")
    first = await run(adapter, "a")
    # The getter copies only the outer list. Exercise both nested dictionaries
    # and outer membership on the persistent Agent, not the invocation copy.
    first.system_prompt_content[0]["text"] = "thread a text"
    first.system_prompt_content[1]["cachePoint"]["ttl"] = "1h"
    first.system_prompt = [*first.system_prompt_content, {"text": "thread a block"}]

    second = await run(adapter, "b")
    reused = await run(adapter, "a")

    assert second.system_prompt_content == BLOCKS
    assert template.system_prompt_content == BLOCKS
    assert reused is first
    assert reused.system_prompt_content[0]["text"] == "thread a text"
    assert reused.system_prompt_content[-1] == {"text": "thread a block"}
    assert first.model is second.model is model


@pytest.mark.asyncio
async def test_reserved_prompt_override_remains_ignored():
    model = RecordingModel()
    adapter = StrandsAgent(
        Agent(model=model, system_prompt=deepcopy(BLOCKS), callback_handler=None),
        name="test",
        config=StrandsAgentConfig(
            thread_agent_kwargs=lambda _: {"system_prompt": "override"},
        ),
    )

    await run(adapter)

    assert model.prompts == [BLOCKS]


@pytest.mark.asyncio
async def test_legacy_agent_like_template_keeps_its_text_prompt():
    model = RecordingModel()
    template = SimpleNamespace(
        model=model,
        system_prompt="Legacy prompt",
        tool_registry=ToolRegistry(),
    )
    adapter = StrandsAgent(template, name="test")

    await run(adapter)

    assert model.prompts == [[{"text": "Legacy prompt"}]]


@pytest.mark.asyncio
async def test_bedrock_formatter_keeps_explicit_checkpoint_and_ttl():
    import boto3
    from strands.models.bedrock import BedrockModel
    from strands.models.model import CacheConfig

    recorder = RecordingModel()
    adapter = StrandsAgent(
        Agent(model=recorder, system_prompt=deepcopy(BLOCKS), callback_handler=None),
        name="test",
    )
    await run(adapter)
    # Construct the real request formatter with dummy credentials; no provider
    # request is sent and no credential lookup is needed.
    session = boto3.Session(
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        region_name="us-east-1",
    )
    model = BedrockModel(
        model_id="anthropic.claude-sonnet-4-20250514-v1:0",
        boto_session=session,
        cache_config=CacheConfig(strategy="auto"),
    )

    request = model.format_request(
        messages=[{"role": "user", "content": [{"text": "hi"}]}],
        system_prompt_content=recorder.prompts[-1],
    )

    assert request["system"] == BLOCKS
