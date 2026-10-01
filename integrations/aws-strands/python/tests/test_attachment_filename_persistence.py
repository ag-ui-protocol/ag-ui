"""Original attachment filenames survive native Strands persistence.

A client names each attachment in the part's ``metadata`` (CopilotKit writes
``metadata.filename``). The model never sees that name: a document's Bedrock
``name`` stays the neutral hashed value. The name has to stay recoverable from
the native store anyway, tied to the block holding its bytes. The adapter records
it on the native user message under ``metadata.custom["ag-ui"]``, one entry per
named block: the block's position in that message's content, the block's kind,
and the filename.

These run a REAL ``strands.Agent`` over a REAL session manager on a temp dir.
Only the model is scripted, and what it receives is bound through the Bedrock
formatter the SDK ships to show the provider request stays name-free.
"""

from __future__ import annotations

import base64
import copy
import json
from pathlib import Path
from typing import Any, Callable

import pytest
from ag_ui.core import (
    AssistantMessage,
    DocumentInputContent,
    EventType,
    FunctionCall,
    ImageInputContent,
    InputContentDataSource,
    RunAgentInput,
    TextInputContent,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
    VideoInputContent,
)
from strands import Agent
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager
from strands.types.content import Message

from ag_ui_strands import StrandsAgent, StrandsAgentConfig
from ag_ui_strands.utils import convert_agui_content_to_strands

try:  # pragma: no cover - depends on the installed SDK
    from strands.session.snapshot_session_manager import SnapshotSessionManager
    from strands.storage import LocalFileStorage
except ImportError:  # pragma: no cover - snapshot sessions arrived in later SDKs
    SnapshotSessionManager = None
    LocalFileStorage = None

THREAD = "attachments-thread"
AGENT_ID = "attachments-agent"

PNG = b"\x89PNG\r\n\x1a\n-holiday"
PDF = b"%PDF-1.7 quarterly"
MP4 = b"\x00\x00\x00\x18ftypmp42-clip"

IMAGE_NAME = "holiday photo.png"
DOCUMENT_NAME = "Q3 report (final).pdf"
VIDEO_NAME = "clip.mp4"
ALL_NAMES = (IMAGE_NAME, DOCUMENT_NAME, VIDEO_NAME)


def _data(raw: bytes, mime: str) -> InputContentDataSource:
    return InputContentDataSource(
        type="data", value=base64.b64encode(raw).decode(), mime_type=mime
    )


def _attachments_message() -> UserMessage:
    return UserMessage(
        id="u1",
        content=[
            TextInputContent(type="text", text="what are these?"),
            ImageInputContent(
                type="image",
                source=_data(PNG, "image/png"),
                metadata={"filename": IMAGE_NAME},
            ),
            DocumentInputContent(
                type="document",
                source=_data(PDF, "application/pdf"),
                metadata={"filename": DOCUMENT_NAME},
            ),
            VideoInputContent(
                type="video",
                source=_data(MP4, "video/mp4"),
                metadata={"fileName": VIDEO_NAME},
            ),
        ],
    )


class _RecordingModel(Model):
    """Answers in words and records the messages it was handed.

    Given ``tool_call``, the first turn calls that tool instead.
    """

    def __init__(self, tool_call: tuple[str, str] | None = None) -> None:
        self.seen: list[list[dict[str, Any]]] = []
        self._tool_call = tool_call

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):  # pragma: no cover
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.seen.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self._tool_call is not None:
            tool_use_id, name = self._tool_call
            self._tool_call = None
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "done"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def _file_manager(path: Path) -> Any:
    return FileSessionManager(session_id=THREAD, storage_dir=str(path))


def _snapshot_manager(path: Path) -> Any:
    return SnapshotSessionManager(
        session_id=THREAD, storage=LocalFileStorage(str(path))
    )


MANAGERS = [
    pytest.param(_file_manager, id="file-session"),
    pytest.param(
        _snapshot_manager,
        id="snapshot-session",
        marks=pytest.mark.skipif(
            SnapshotSessionManager is None,
            reason="SnapshotSessionManager ships in newer strands-agents releases",
        ),
    ),
]


WEATHER = Tool(name="get_weather", description="get_weather", parameters={"type": "object"})


def _adapter(
    manager: Callable[[], Any] | None,
    model: _RecordingModel | None = None,
) -> tuple[StrandsAgent, _RecordingModel]:
    model = model or _RecordingModel()
    adapter = StrandsAgent(
        Agent(model=model, callback_handler=None, agent_id=AGENT_ID),
        name="attachments",
        config=StrandsAgentConfig(
            session_manager_provider=(
                (lambda _input: manager()) if manager is not None else None
            ),
        ),
    )
    return adapter, model


def _input(run_id: str, messages: list[Any]) -> RunAgentInput:
    return RunAgentInput(
        thread_id=THREAD,
        run_id=run_id,
        state={},
        messages=messages,
        tools=[WEATHER],
        context=[],
        forwarded_props={},
    )


async def _run(adapter: StrandsAgent, input_data: RunAgentInput) -> None:
    events = [event async for event in adapter.run(input_data)]
    assert [e for e in events if e.type == EventType.RUN_ERROR] == [], events
    assert events[-1].type == EventType.RUN_FINISHED


def _reload(manager: Callable[[], Any]) -> list[dict[str, Any]]:
    """The history a fresh process restores from the store alone."""
    agent = Agent(
        model=_RecordingModel(),
        callback_handler=None,
        agent_id=AGENT_ID,
        session_manager=manager(),
    )
    return agent.messages


def _media_kind(block: dict[str, Any]) -> str:
    [kind] = block.keys()
    return kind


def _named_blocks(message: dict[str, Any]) -> list[tuple[str, str, str, bytes]]:
    """(filename, kind, format, bytes) for every named block of a message."""
    entries = (
        (message.get("metadata") or {})
        .get("custom", {})
        .get("ag-ui", {})
        .get("attachments", [])
    )
    named = []
    for entry in entries:
        block = message["content"][entry["index"]]
        kind = _media_kind(block)
        assert kind == entry["type"], (entry, block)
        named.append(
            (
                entry["filename"],
                kind,
                block[kind]["format"],
                block[kind]["source"]["bytes"],
            )
        )
    return named


def _bedrock_request(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from strands.models.bedrock import BedrockModel

    model = BedrockModel(model_id="anthropic.claude-sonnet-4", region_name="us-east-1")
    return model._format_bedrock_messages(messages)


def _assert_provider_request_is_name_free(seen: list[dict[str, Any]]) -> None:
    if "metadata" in Message.__annotations__:
        # SDKs that declare the field strip it before the model is called.
        assert all("metadata" not in message for message in seen), seen
    request = _bedrock_request(seen)
    wire = json.dumps(request, default=lambda raw: f"<{len(raw)} bytes>")
    for name in ALL_NAMES:
        assert name not in wire
    assert '"metadata"' not in wire
    [document] = [
        block["document"]
        for message in request
        for block in message["content"]
        if "document" in block
    ]
    assert document["name"].startswith("document-")
    assert document["source"]["bytes"] == PDF


@pytest.mark.asyncio
@pytest.mark.parametrize("manager_factory", MANAGERS)
async def test_original_filenames_are_recoverable_from_the_native_store(
    tmp_path, manager_factory
):
    manager = lambda: manager_factory(tmp_path)  # noqa: E731
    adapter, model = _adapter(manager)

    await _run(adapter, _input("run-1", [_attachments_message()]))

    restored = _reload(manager)
    assert [message["role"] for message in restored] == ["user", "assistant"]
    assert _named_blocks(restored[0]) == [
        (IMAGE_NAME, "image", "png", PNG),
        (DOCUMENT_NAME, "document", "pdf", PDF),
        (VIDEO_NAME, "video", "mp4", MP4),
    ]
    [document] = [block["document"] for block in restored[0]["content"] if "document" in block]
    assert document["name"].startswith("document-")
    assert DOCUMENT_NAME not in document["name"]

    [turn] = model.seen
    _assert_provider_request_is_name_free(turn)


@pytest.mark.asyncio
@pytest.mark.parametrize("manager_factory", MANAGERS)
async def test_a_later_turn_keeps_one_named_record_and_a_name_free_request(
    tmp_path, manager_factory
):
    manager = lambda: manager_factory(tmp_path)  # noqa: E731
    first = _attachments_message()
    adapter, _ = _adapter(manager)
    await _run(adapter, _input("run-1", [first]))

    # A new process, and a client that resends the whole thread.
    adapter, model = _adapter(manager)
    await _run(
        adapter,
        _input(
            "run-2",
            [
                first,
                AssistantMessage(id="a1", content="done"),
                UserMessage(id="u2", content="and which one is newest?"),
            ],
        ),
    )

    restored = _reload(manager)
    assert [message["role"] for message in restored] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert [_named_blocks(message) for message in restored] == [
        [
            (IMAGE_NAME, "image", "png", PNG),
            (DOCUMENT_NAME, "document", "pdf", PDF),
            (VIDEO_NAME, "video", "mp4", MP4),
        ],
        [],
        [],
        [],
    ]
    media = [
        block
        for message in restored
        for block in message["content"]
        if _media_kind(block) in ("image", "document", "video")
    ]
    assert len(media) == 3

    [turn] = model.seen
    assert len(turn) == 3
    _assert_provider_request_is_name_free(turn)


EXPECTED_NAMED = [
    (IMAGE_NAME, "image", "png", PNG),
    (DOCUMENT_NAME, "document", "pdf", PDF),
    (VIDEO_NAME, "video", "mp4", MP4),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("manager_factory", MANAGERS)
async def test_reconciling_a_frontend_answer_keeps_the_names_on_their_message(
    tmp_path, manager_factory
):
    manager = lambda: manager_factory(tmp_path)  # noqa: E731
    first = _attachments_message()
    call = AssistantMessage(
        id="a1",
        tool_calls=[
            ToolCall(id="native-w", function=FunctionCall(name="get_weather", arguments="{}"))
        ],
    )
    adapter, model = _adapter(manager, _RecordingModel(("native-w", "get_weather")))
    await _run(adapter, _input("run-1", [first]))
    await _run(
        adapter,
        _input(
            "run-2",
            [first, call, ToolMessage(id="t1", tool_call_id="native-w", content="sunny")],
        ),
    )

    restored = _reload(manager)
    assert [_named_blocks(message) for message in restored] == [
        EXPECTED_NAMED,
        *([[]] * (len(restored) - 1)),
    ]
    results = [
        block["toolResult"]
        for message in restored
        for block in message["content"]
        if "toolResult" in block
    ]
    assert [result["content"] for result in results] == [[{"text": "sunny"}]]
    _assert_provider_request_is_name_free(model.seen[-1])


@pytest.mark.asyncio
async def test_replayed_history_names_each_attachment_once_on_its_own_message():
    adapter, model = _adapter(None)
    first = _attachments_message()
    await _run(adapter, _input("run-1", [first]))
    await _run(
        adapter,
        _input(
            "run-2",
            [
                first,
                AssistantMessage(id="a1", content="done"),
                UserMessage(id="u2", content="and which one is newest?"),
            ],
        ),
    )

    history = adapter._agents_by_thread[THREAD].messages
    assert [message["role"] for message in history] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert [_named_blocks(message) for message in history] == [EXPECTED_NAMED, [], [], []]
    _assert_provider_request_is_name_free(model.seen[-1])


@pytest.mark.asyncio
async def test_a_named_attachment_on_its_own_is_indexed_past_the_blank_text_block(
    tmp_path,
):
    manager = lambda: _file_manager(tmp_path)  # noqa: E731
    adapter, _ = _adapter(manager)
    await _run(
        adapter,
        _input(
            "run-1",
            [
                UserMessage(
                    id="u1",
                    content=[
                        DocumentInputContent(
                            type="document",
                            source=_data(PDF, "application/pdf"),
                            metadata={"filename": DOCUMENT_NAME},
                        )
                    ],
                )
            ],
        ),
    )

    [user, _] = _reload(manager)
    # Bedrock needs a text block beside a document, so one is put first.
    assert user["content"][0] == {"text": " "}
    assert _named_blocks(user) == [(DOCUMENT_NAME, "document", "pdf", PDF)]


def test_a_dropped_attachment_does_not_move_a_later_name():
    named: list[tuple[dict[str, Any], str]] = []
    blocks = convert_agui_content_to_strands(
        [
            ImageInputContent(
                type="image",
                source=_data(b"BM-bitmap", "image/bmp"),
                metadata={"filename": "dropped.bmp"},
            ),
            ImageInputContent(
                type="image",
                source=_data(PNG, "image/png"),
                metadata={"filename": IMAGE_NAME},
            ),
            ImageInputContent(
                type="image",
                source=_data(b"\xff\xd8jpeg", "image/jpeg"),
                metadata={"filename": "later.jpg"},
            ),
        ],
        filenames=named,
    )

    assert [(_media_kind(block), name) for block, name in named] == [
        ("image", IMAGE_NAME),
        ("image", "later.jpg"),
    ]
    assert [block for block, _ in named] == blocks
    assert named[0][0]["image"]["source"]["bytes"] == PNG


def test_an_unnamed_or_blank_name_records_nothing():
    named: list[tuple[dict[str, Any], str]] = []
    convert_agui_content_to_strands(
        [
            ImageInputContent(type="image", source=_data(PNG, "image/png")),
            ImageInputContent(
                type="image",
                source=_data(PNG, "image/png"),
                metadata={"filename": "   ", "fileName": 7},
            ),
        ],
        filenames=named,
    )
    assert named == []
