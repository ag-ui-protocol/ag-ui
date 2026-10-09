"""Cross-thread trimming must not corrupt a pending session after process restart."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


@pytest.mark.parametrize("imported", [False, True], ids=["fresh", "native-only-copy"])
def test_frontend_resume_appends_after_another_thread_was_trimmed(tmp_path, imported):
    source = tmp_path / "source"
    _process(source, "seed")
    before = _records(source)
    assert [r["message"]["role"] for r in before] == ["user", "assistant", "user"]
    store = tmp_path / "imported" if imported else source
    if imported:
        # Copy the complete native-only session without changing its metadata.
        # The Intelligence import/browser boundary is validated separately.
        shutil.copytree(source, store)
    _process(store, "resume")
    after = _records(store)
    assert [r["message_id"] for r in after] == [0, 1, 2, 3]
    assert after[:2] == before[:2]
    assert after[2]["message"]["content"][0]["toolResult"] == {
        "toolUseId": "picker-call",
        "status": "success",
        "content": [{"text": "Tomorrow 2:00 PM"}],
    }
    assert after[2]["message"]["tracking_id"] == before[2]["message"]["tracking_id"]
    assert after[3]["message"]["role"] == "assistant"
    _process(store, "continue")
    continued = _records(store)
    assert continued[:4] == after
    assert [r["message_id"] for r in continued] == [0, 1, 2, 3, 4, 5]
    if imported:
        assert _records(source) == before


def _records(store):
    folder = store / "session_picker/agents/agent_default/messages"
    return [json.loads(p.read_text()) for p in sorted(folder.glob("message_*.json"))]


def _process(store, phase):
    package = Path(__file__).resolve().parents[1]
    env = dict(
        os.environ, PYTHONPATH=os.pathsep.join([str(package / "src"), str(package)])
    )
    result = subprocess.run(
        [sys.executable, "-m", "tests.conversation_manager_process", str(store), phase],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.asyncio
async def test_uncopyable_manager_can_be_supplied_per_thread():
    from strands import Agent
    from strands.agent.conversation_manager import SlidingWindowConversationManager
    from ag_ui_strands import StrandsAgent, StrandsAgentConfig
    from tests.conversation_manager_process import PickerModel, drive

    class UncopyableManager(SlidingWindowConversationManager):
        def __deepcopy__(self, memo):
            raise TypeError("use a per-thread factory")

    adapter = StrandsAgent(
        Agent(
            model=PickerModel(),
            conversation_manager=UncopyableManager(),
            callback_handler=None,
        ),
        name="custom",
        config=StrandsAgentConfig(
            thread_agent_kwargs=lambda _: {
                "conversation_manager": UncopyableManager(window_size=2),
            }
        ),
    )
    from ag_ui.core import UserMessage

    for thread in ["a", "b"]:
        await drive(adapter, thread, [UserMessage(id="u", content="ordinary turn")])
    first, second = (
        adapter._agents_by_thread[t].conversation_manager for t in ["a", "b"]
    )
    assert first is not second
    assert first.window_size == second.window_size == 2


@pytest.mark.asyncio
async def test_uncopyable_template_manager_fails_without_caching_a_thread():
    from strands import Agent
    from strands.agent.conversation_manager import SlidingWindowConversationManager
    from ag_ui_strands import StrandsAgent
    from ag_ui.core import UserMessage
    from tests.conversation_manager_process import PickerModel, run_input

    class UncopyableManager(SlidingWindowConversationManager):
        def __deepcopy__(self, memo):
            raise TypeError("use a per-thread factory")

    adapter = StrandsAgent(
        Agent(
            model=PickerModel(),
            conversation_manager=UncopyableManager(),
            callback_handler=None,
        ),
        name="custom",
    )
    events = [
        event
        async for event in adapter.run(
            run_input("a", [UserMessage(id="u", content="hi")])
        )
    ]
    assert [event.type for event in events] == ["RUN_STARTED", "RUN_ERROR"]
    assert events[-1].code == "THREAD_AGENT_KWARGS_ERROR"
    assert "a" not in adapter._agents_by_thread


@pytest.mark.asyncio
@pytest.mark.parametrize("pin_first", [None, 2])
async def test_used_template_manager_is_rejected_before_saving_a_new_thread(
    tmp_path, pin_first
):
    from strands import Agent
    from strands.agent.conversation_manager import SlidingWindowConversationManager
    from strands.session.file_session_manager import FileSessionManager
    from ag_ui.core import UserMessage
    from ag_ui_strands import StrandsAgent, StrandsAgentConfig
    from tests.conversation_manager_process import PickerModel, run_input

    template = Agent(
        model=PickerModel(),
        callback_handler=None,
        conversation_manager=SlidingWindowConversationManager(
            window_size=2, pin_first=pin_first
        ),
    )
    for _ in range(2):
        await template.invoke_async("ordinary turn")
    if pin_first:
        assert template.conversation_manager._pin_first_applied is True
        assert not any(
            value
            for key, value in template.conversation_manager.get_state().items()
            if key != "__name__"
        )
    else:
        assert template.conversation_manager.removed_message_count > 0
    state_before = template.conversation_manager.get_state()
    adapter = StrandsAgent(
        template,
        name="used",
        config=StrandsAgentConfig(
            session_manager_provider=lambda i: FileSessionManager(
                session_id=i.thread_id,
                storage_dir=str(tmp_path),
            ),
        ),
    )
    events = [
        event
        async for event in adapter.run(
            run_input(
                "new",
                [UserMessage(id="u", content="ordinary turn")],
            )
        )
    ]
    assert [event.type for event in events] == ["RUN_STARTED", "RUN_ERROR"]
    assert events[-1].code == "THREAD_AGENT_KWARGS_ERROR"
    assert "thread_agent_kwargs" in events[-1].message
    assert "new" not in adapter._agents_by_thread
    assert not list(tmp_path.rglob("message_*.json"))
    assert template.conversation_manager.get_state() == state_before


@pytest.mark.asyncio
async def test_sdk_summarizer_with_nested_agent_explains_required_factory():
    from strands import Agent
    from strands.agent.conversation_manager import SummarizingConversationManager
    from ag_ui.core import UserMessage
    from ag_ui_strands import StrandsAgent
    from tests.conversation_manager_process import PickerModel, run_input

    adapter = StrandsAgent(
        Agent(
            model=PickerModel(),
            callback_handler=None,
            conversation_manager=SummarizingConversationManager(
                summarization_agent=Agent(model=PickerModel(), callback_handler=None),
            ),
        ),
        name="summary",
    )
    events = [
        event
        async for event in adapter.run(
            run_input(
                "new",
                [UserMessage(id="u", content="ordinary turn")],
            )
        )
    ]
    assert events[-1].code == "THREAD_AGENT_KWARGS_ERROR"
    assert "thread_agent_kwargs" in events[-1].message
    assert "conversation_manager" in events[-1].message
    assert "new" not in adapter._agents_by_thread


@pytest.mark.asyncio
async def test_sdk_summarizer_factory_runs_and_restores_file_sessions(tmp_path):
    import asyncio

    from strands import Agent
    from strands.agent.conversation_manager import SummarizingConversationManager
    from strands.session.file_session_manager import FileSessionManager
    from ag_ui.core import UserMessage
    from ag_ui_strands import StrandsAgent, StrandsAgentConfig
    from tests.conversation_manager_process import PickerModel, drive

    def manager():
        return SummarizingConversationManager(
            summary_ratio=0.4,
            preserve_recent_messages=2,
            summarization_agent=Agent(model=PickerModel(), callback_handler=None),
        )

    def adapter():
        return StrandsAgent(
            Agent(
                model=PickerModel(),
                callback_handler=None,
                conversation_manager=manager(),
            ),
            name="summary",
            config=StrandsAgentConfig(
                thread_agent_kwargs=lambda _: {"conversation_manager": manager()},
                session_manager_provider=lambda i: FileSessionManager(
                    session_id=i.thread_id,
                    storage_dir=str(tmp_path),
                ),
            ),
        )

    first = adapter()
    for thread in ["a", "b"]:
        for turn in range(3):
            await drive(
                first, thread, [UserMessage(id=f"u{turn}", content="ordinary turn")]
            )
        core = first._agents_by_thread[thread]
        # Exercise the real nested summarization Agent and persist its summary,
        # rather than proving only that the factory can construct a manager.
        await asyncio.to_thread(
            core.conversation_manager.reduce_context,
            core,
            RuntimeError("reduce history"),
        )
        core._session_manager.sync_agent(core)
    a, b = (first._agents_by_thread[t].conversation_manager for t in ["a", "b"])
    assert a is not b and a.summarization_agent is not b.summarization_agent
    assert a.summary_ratio == b.summary_ratio == 0.4
    assert a.removed_message_count > 0 and b.removed_message_count > 0
    assert a.get_state()["summary_message"] is not None
    summaries = {
        t: first._agents_by_thread[t].conversation_manager.get_state()
        for t in ["a", "b"]
    }
    original = {p: p.read_bytes() for p in tmp_path.rglob("message_*.json")}
    restarted = adapter()
    for thread in ["a", "b"]:
        await drive(
            restarted, thread, [UserMessage(id="u2", content="next ordinary turn")]
        )
    assert all(p.read_bytes() == data for p, data in original.items())
    for thread in ["a", "b"]:
        paths = sorted(
            (tmp_path / f"session_{thread}/agents/agent_default/messages").glob(
                "*.json"
            )
        )
        assert [json.loads(p.read_text())["message_id"] for p in paths] == list(
            range(8)
        )
        assert (
            restarted._agents_by_thread[thread].conversation_manager.get_state()
            == summaries[thread]
        )
