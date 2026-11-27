"""A thread nobody has run for a while is let go, and comes back from its history.

Each thread's agent is kept between runs, so without a timeout a process holds
every thread it has ever served. ``thread_idle_timeout`` is checked when a run
starts, so a timeout of zero lets every other finished thread go on each run.
"""

from __future__ import annotations

import pytest
from ag_ui.core import AssistantMessage, EventType, UserMessage
from strands import Agent

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig
from tests.scripted_model import ScriptedModel, collect, run_input


def _adapter(script, timeout) -> tuple[StrandsAgent, ScriptedModel]:
    model = ScriptedModel(script)
    template = Agent(model=model, callback_handler=None)
    config = StrandsAgentConfig(thread_idle_timeout=timeout)
    return StrandsAgent(agent=template, name="a", config=config), model


@pytest.mark.asyncio
async def test_without_a_timeout_every_thread_is_kept():
    adapter, _ = _adapter(lambda *_: "hello", None)
    await collect(adapter, run_input(thread_id="one"))
    await collect(adapter, run_input(thread_id="two"))
    assert set(adapter._agents_by_thread) == {"one", "two"}


@pytest.mark.asyncio
async def test_an_idle_thread_is_let_go_and_shut_down_when_another_run_starts():
    adapter, _ = _adapter(lambda *_: "hello", 0)
    await collect(adapter, run_input(thread_id="one"))
    closed = []
    # Newer SDKs have an async shutdown, which is the one used where it exists.
    agent = adapter._agents_by_thread["one"]
    if callable(getattr(agent, "shutdown_async", None)):

        async def shutdown_async():
            closed.append("one")

        agent.shutdown_async = shutdown_async
    else:
        agent.shutdown = lambda: closed.append("one")

    await collect(adapter, run_input(thread_id="two"))

    assert set(adapter._agents_by_thread) == {"two"}
    assert closed == ["one"]
    # Nothing else of the thread stays behind either.
    for kept in (
        adapter._proxy_tool_names_by_thread,
        adapter._pending_interrupts_by_thread,
        adapter._last_resume_fingerprint,
        adapter._frontend_wait_bridge_by_thread,
        adapter._thread_last_run_ended,
    ):
        assert "one" not in kept


@pytest.mark.asyncio
async def test_a_thread_is_kept_until_it_has_been_idle_that_long():
    adapter, _ = _adapter(lambda *_: "hello", 3600)
    await collect(adapter, run_input(thread_id="one"))
    await collect(adapter, run_input(thread_id="two"))
    assert set(adapter._agents_by_thread) == {"one", "two"}


@pytest.mark.asyncio
async def test_a_thread_with_a_run_in_progress_is_never_let_go():
    adapter, _ = _adapter(lambda *_: "hello", 0)
    await collect(adapter, run_input(thread_id="one"))
    running = adapter.run(run_input(thread_id="one", run_id="r2"))
    # Far enough in for the thread's run to hold its agent.
    async for event in running:
        if event.type == EventType.TEXT_MESSAGE_START:
            break
    agent = adapter._agents_by_thread["one"]

    await collect(adapter, run_input(thread_id="two"))

    assert adapter._agents_by_thread["one"] is agent
    await running.aclose()


@pytest.mark.asyncio
async def test_a_thread_that_was_let_go_carries_on_from_the_clients_history():
    def script(_model, messages):
        said = " ".join(
            block.get("text", "") for message in messages for block in message["content"]
        )
        return "the word was otter" if "otter" in said else "no idea"

    adapter, _ = _adapter(script, 0)
    await collect(adapter, run_input(thread_id="one", messages=[UserMessage(id="u1", content="the word is otter")]))
    await collect(adapter, run_input(thread_id="two"))
    assert "one" not in adapter._agents_by_thread

    events = await collect(
        adapter,
        run_input(
            thread_id="one",
            run_id="r2",
            messages=[
                UserMessage(id="u1", content="the word is otter"),
                AssistantMessage(id="a1", content="the word was otter"),
                UserMessage(id="u2", content="what was the word?"),
            ],
        ),
    )
    text = "".join(e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT)
    assert text == "the word was otter"


def test_a_negative_timeout_is_refused():
    with pytest.raises(ValueError, match="thread_idle_timeout"):
        StrandsAgentConfig(thread_idle_timeout=-1)
