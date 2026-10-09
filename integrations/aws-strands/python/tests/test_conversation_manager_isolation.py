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
