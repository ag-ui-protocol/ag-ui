#!/usr/bin/env python
"""User attachments survive a real database-backed ADK session.

Runs ADKAgent against google.adk's DatabaseSessionService on SQLite, then
reopens the database with a fresh service and checks that every attachment
is stored exactly once with its bytes, MIME type and original filename, and
that the message history rebuilt from it carries the same.
"""

import base64
import hashlib
from typing import AsyncGenerator, List

import pytest

from ag_ui.core import (
    AssistantMessage,
    AudioInputContent,
    BaseEvent,
    DocumentInputContent,
    EventType,
    ImageInputContent,
    InputContentDataSource,
    RunAgentInput,
    TextInputContent,
    UserMessage,
    VideoInputContent,
)
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import DatabaseSessionService
from google.genai import types

from ag_ui_adk import ADKAgent, adk_events_to_messages
from ag_ui_adk.session_manager import SessionManager

APP_NAME = "attachment_app"
USER_ID = "attachment_user"
THREAD_ID = "attachment_thread"


def _payload(magic: bytes, size: int) -> bytes:
    """Deterministic bytes of an exact size, starting with a format signature."""
    filler = bytes((i * 31 + 7) % 256 for i in range(size))
    return (magic + filler)[:size]


ATTACHMENTS = [
    (ImageInputContent, "image/png", "screenshot.png", _payload(b"\x89PNG\r\n\x1a\n", 10083)),
    (DocumentInputContent, "application/pdf", "Q3 report.pdf", _payload(b"%PDF-1.4\n", 2486)),
    (AudioInputContent, "audio/wav", "voice memo.wav", _payload(b"RIFF\x00\x00\x00\x00WAVEfmt ", 87078)),
    (VideoInputContent, "video/mp4", "clip.mp4", _payload(b"\x00\x00\x00\x18ftypmp42", 2290)),
]
EXPECTED = {
    filename: (mime_type, hashlib.sha256(data).hexdigest(), len(data))
    for _, mime_type, filename, data in ATTACHMENTS
}


class _EchoLlm(BaseLlm):
    """Answers every request with fixed text so no provider is contacted."""

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="Received.")]),
            partial=False,
            turn_complete=True,
        )


def _make_agent(session_service: DatabaseSessionService) -> ADKAgent:
    return ADKAgent(
        adk_agent=LlmAgent(name="attachment_agent", model=_EchoLlm(model="fake")),
        app_name=APP_NAME,
        user_id=USER_ID,
        session_service=session_service,
        use_thread_id_as_session_id=True,
    )


def _first_user_message() -> UserMessage:
    return UserMessage(
        id="u1",
        role="user",
        content=[TextInputContent(text="Here are my files.")]
        + [
            content_cls(
                source=InputContentDataSource(
                    value=base64.b64encode(data).decode("ascii"), mime_type=mime_type
                ),
                metadata={"filename": filename},
            )
            for content_cls, mime_type, filename, data in ATTACHMENTS
        ],
    )


async def _run(agent: ADKAgent, run_id: str, messages: list) -> List[BaseEvent]:
    run_input = RunAgentInput(
        thread_id=THREAD_ID,
        run_id=run_id,
        messages=messages,
        context=[],
        state={},
        tools=[],
        forwarded_props={},
    )
    events = [event async for event in agent.run(run_input)]
    types_seen = [event.type for event in events]
    assert EventType.RUN_FINISHED in types_seen, types_seen
    assert EventType.RUN_ERROR not in types_seen, [
        getattr(e, "message", None) for e in events if e.type == EventType.RUN_ERROR
    ]
    return events


def _assistant_reply(events: List[BaseEvent]) -> AssistantMessage:
    """Rebuild the assistant message the client would hold after a run."""
    message_id = next(e.message_id for e in events if e.type == EventType.TEXT_MESSAGE_START)
    text = "".join(
        e.delta for e in events
        if e.type == EventType.TEXT_MESSAGE_CONTENT and e.message_id == message_id
    )
    return AssistantMessage(id=message_id, role="assistant", content=text)


def _stored_blobs(session) -> List[types.Blob]:
    return [
        part.inline_data
        for event in session.events
        if event.content and event.content.parts
        for part in event.content.parts
        if part.inline_data is not None
    ]


def _describe_events(session) -> str:
    lines = []
    for event in session.events:
        parts = []
        for part in (event.content.parts if event.content and event.content.parts else []):
            if part.inline_data is not None:
                blob = part.inline_data
                parts.append(f"blob({blob.mime_type}, {len(blob.data or b'')}B, {blob.display_name!r})")
            elif part.text:
                parts.append(f"text({part.text!r})")
            else:
                parts.append("other")
        lines.append(f"{event.author} inv={event.invocation_id}: {parts}")
    return "\n".join(lines)


def _assert_attachments_stored_once(session) -> None:
    blobs = _stored_blobs(session)
    assert len(blobs) == len(ATTACHMENTS), _describe_events(session)
    stored = {
        blob.display_name: (blob.mime_type, hashlib.sha256(blob.data).hexdigest(), len(blob.data))
        for blob in blobs
    }
    assert stored == EXPECTED, _describe_events(session)


def _user_texts(session) -> List[str]:
    return [
        "".join(part.text or "" for part in event.content.parts)
        for event in session.events
        if event.author == "user" and event.content and event.content.parts
    ]


def _assert_history_carries_attachments(session) -> None:
    messages = adk_events_to_messages(session.events)
    with_media = [
        m for m in messages if isinstance(m, UserMessage) and isinstance(m.content, list)
    ]
    assert len(with_media) == 1, messages
    content = with_media[0].content

    assert isinstance(content[0], TextInputContent)
    assert content[0].text == "Here are my files."
    media = content[1:]
    assert [type(p) for p in media] == [cls for cls, _, _, _ in ATTACHMENTS]
    for part, (_, mime_type, filename, data) in zip(media, ATTACHMENTS):
        assert isinstance(part.source, InputContentDataSource)
        assert part.source.mime_type == mime_type
        assert hashlib.sha256(base64.b64decode(part.source.value)).hexdigest() == (
            hashlib.sha256(data).hexdigest()
        )
        assert part.metadata == {"filename": filename}


async def _reopen(db_url: str):
    service = DatabaseSessionService(db_url=db_url)
    session = await service.get_session(app_name=APP_NAME, user_id=USER_ID, session_id=THREAD_ID)
    return service, session


class TestAttachmentPersistence:
    """Attachments written through ADKAgent come back intact from a SQLite session store."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def db_url(self, tmp_path):
        return f"sqlite+aiosqlite:///{tmp_path}/sessions.sqlite"

    async def _two_turns(self, db_url: str):
        service = DatabaseSessionService(db_url=db_url)
        agent = _make_agent(service)
        u1 = _first_user_message()
        u2 = UserMessage(id="u2", role="user", content="Thanks, one more question.")
        try:
            a1 = _assistant_reply(await _run(agent, "r1", [u1]))
            a2 = _assistant_reply(await _run(agent, "r2", [u1, a1, u2]))
        finally:
            await agent.close()
            await service.close()
        return u1, a1, u2, a2

    @pytest.mark.asyncio
    async def test_attachments_are_stored_once_with_filenames(self, db_url):
        await self._two_turns(db_url)

        service, session = await _reopen(db_url)
        try:
            assert session is not None
            assert _user_texts(session) == ["Here are my files.", "Thanks, one more question."]
            _assert_attachments_stored_once(session)
            _assert_history_carries_attachments(session)
        finally:
            await service.close()

    @pytest.mark.asyncio
    async def test_restarted_agent_does_not_duplicate_attachments(self, db_url):
        """A new ADKAgent on the same database has no in-memory record of
        which messages it already processed, and the client resends the full
        history including the message that carried the attachments."""
        u1, a1, u2, a2 = await self._two_turns(db_url)

        service = DatabaseSessionService(db_url=db_url)
        agent = _make_agent(service)
        u3 = UserMessage(id="u3", role="user", content="And a final one.")
        try:
            await _run(agent, "r3", [u1, a1, u2, a2, u3])
        finally:
            await agent.close()
            await service.close()

        service, session = await _reopen(db_url)
        try:
            assert _user_texts(session) == [
                "Here are my files.", "Thanks, one more question.", "And a final one.",
            ]
            _assert_attachments_stored_once(session)
            _assert_history_carries_attachments(session)
        finally:
            await service.close()
