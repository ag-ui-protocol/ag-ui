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
    AudioInputContent,
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

from tests.media_helpers import (
    accepting_bedrock_model,
    ensure_audio_capable_sdk,
    sdk_has_audio,
    wav_bytes,
)

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
    model: Any = None,
    **config: Any,
) -> tuple[StrandsAgent, Any]:
    model = model or _RecordingModel()
    adapter = StrandsAgent(
        Agent(model=model, callback_handler=None, agent_id=AGENT_ID),
        name="attachments",
        config=StrandsAgentConfig(
            session_manager_provider=(
                (lambda _input: manager()) if manager is not None else None
            ),
            **config,
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


AUDIO_NAME = "voice memo.wav"
WAV = wav_bytes()


def _audio_message(audio_name: str = AUDIO_NAME) -> UserMessage:
    return UserMessage(
        id="u1",
        content=[
            TextInputContent(type="text", text="what is in this recording?"),
            ImageInputContent(
                type="image",
                source=_data(PNG, "image/png"),
                metadata={"filename": IMAGE_NAME},
            ),
            AudioInputContent(
                type="audio",
                source=_data(WAV, "audio/wav"),
                metadata={"filename": audio_name},
            ),
            VideoInputContent(
                type="video",
                source=_data(MP4, "video/mp4"),
                metadata={"fileName": VIDEO_NAME},
            ),
        ],
    )


def _bedrock_model() -> tuple[Any, dict[str, Any]]:
    """A Bedrock model the config declares audio-capable."""
    return accepting_bedrock_model(), {"audio_input_supported": True}


def _declared_audio_model() -> tuple[Any, dict[str, Any]]:
    """A custom model the config declares audio-capable."""
    return _RecordingModel(), {"audio_input_supported": True}


AUDIO_MODELS = [
    pytest.param(_bedrock_model, id="bedrock-enabled"),
    pytest.param(_declared_audio_model, id="declared-true"),
]


def _history_seen(model: Any) -> list[dict[str, Any]]:
    return (model.calls if hasattr(model, "calls") else model.seen)[-1]


@pytest.mark.asyncio
@pytest.mark.skipif(not sdk_has_audio(), reason="installed strands-agents has no audio block")
@pytest.mark.parametrize("model_factory", AUDIO_MODELS)
@pytest.mark.parametrize("manager_factory", MANAGERS)
async def test_delivered_audio_keeps_its_filename_through_a_restart_and_another_turn(
    tmp_path, manager_factory, model_factory
):
    manager = lambda: manager_factory(tmp_path)  # noqa: E731
    first = _audio_message()
    model, config = model_factory()
    adapter, _ = _adapter(manager, model, **config)
    await _run(adapter, _input("run-1", [first]))

    expected = [
        (IMAGE_NAME, "image", "png", PNG),
        (AUDIO_NAME, "audio", "wav", WAV),
        (VIDEO_NAME, "video", "mp4", MP4),
    ]
    [user, _] = _reload(manager)
    assert _named_blocks(user) == expected
    assert [entry["index"] for entry in user["metadata"]["custom"]["ag-ui"]["attachments"]] == [
        1,
        2,
        3,
    ]

    # A new process, and a client that resends the whole thread.
    model, config = model_factory()
    adapter, _ = _adapter(manager, model, **config)
    await _run(
        adapter,
        _input(
            "run-2",
            [
                first,
                AssistantMessage(id="a1", content="done"),
                UserMessage(id="u2", content="and how long is it?"),
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
    assert [_named_blocks(message) for message in restored] == [expected, [], [], []]
    audio = [block for message in restored for block in message["content"] if "audio" in block]
    assert audio == [{"audio": {"format": "wav", "source": {"bytes": WAV}}}]

    seen = _history_seen(model)
    assert len(seen) == 3
    assert {"audio": {"format": "wav", "source": {"bytes": WAV}}} in seen[0]["content"]
    wire = json.dumps(_bedrock_request(seen), default=lambda raw: f"<{len(raw)} bytes>")
    for name in (IMAGE_NAME, AUDIO_NAME, VIDEO_NAME):
        assert name not in wire


@pytest.mark.asyncio
@pytest.mark.parametrize("manager_factory", MANAGERS)
async def test_dropped_audio_leaves_no_name_and_the_others_keep_their_index(
    tmp_path, manager_factory
):
    manager = lambda: manager_factory(tmp_path)  # noqa: E731
    adapter, _ = _adapter(manager)

    events = [event async for event in adapter.run(_input("run-1", [_audio_message()]))]
    assert [e for e in events if e.type == EventType.RUN_ERROR] == []
    [dropped] = [e.value for e in events if e.type == EventType.CUSTOM]
    assert [entry["type"] for entry in dropped["dropped"]] == ["audio"]

    [user, _] = _reload(manager)
    assert [_media_kind(block) for block in user["content"]] == ["text", "image", "video"]
    assert _named_blocks(user) == [
        (IMAGE_NAME, "image", "png", PNG),
        (VIDEO_NAME, "video", "mp4", MP4),
    ]
    assert [entry["index"] for entry in user["metadata"]["custom"]["ag-ui"]["attachments"]] == [
        1,
        2,
    ]
    assert AUDIO_NAME not in json.dumps(user, default=lambda raw: f"<{len(raw)} bytes>")


def test_converted_audio_is_named_and_refused_audio_is_not(monkeypatch):
    ensure_audio_capable_sdk(monkeypatch)
    parts = [
        AudioInputContent(
            type="audio",
            source=_data(WAV, "audio/wav"),
            metadata={"filename": AUDIO_NAME},
        ),
        ImageInputContent(
            type="image",
            source=_data(PNG, "image/png"),
            metadata={"filename": IMAGE_NAME},
        ),
    ]

    named: list[tuple[dict[str, Any], str]] = []
    blocks = convert_agui_content_to_strands(parts, filenames=named, audio_input_supported=True)
    assert [(_media_kind(block), name) for block, name in named] == [
        ("audio", AUDIO_NAME),
        ("image", IMAGE_NAME),
    ]
    assert [block for block, _ in named] == blocks

    named = []
    blocks = convert_agui_content_to_strands(parts, filenames=named, audio_input_supported=False)
    assert [(_media_kind(block), name) for block, name in named] == [("image", IMAGE_NAME)]
    assert [block for block, _ in named] == blocks
