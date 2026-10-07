"""Real media payloads, SDK audio capability and offline provider helpers shared by tests."""

from __future__ import annotations

import base64
import io
import struct
import wave
import zlib
from types import SimpleNamespace
from typing import Any, List

from ag_ui.core import (
    AudioInputContent,
    ImageInputContent,
    InputContentDataSource,
)

import ag_ui_strands.utils as utils

# ``strands.types.media.AudioFormat`` as shipped from 1.53.0 through 1.57.1.
STRANDS_AUDIO_FORMATS = frozenset(
    {
        "mp3", "opus", "wav", "aac", "flac", "mp4", "ogg", "mkv", "mka",
        "x-aac", "m4a", "mpeg", "mpga", "pcm", "webm",
    }
)


def wav_bytes(frames: int = 43517) -> bytes:
    """A valid 16 kHz mono 16-bit WAV file (87,078 bytes by default)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(bytes((i * 7) % 256 for i in range(frames * 2)))
    return buf.getvalue()


def png_bytes() -> bytes:
    """A valid 1x1 RGB PNG."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
        + chunk(b"IEND", b"")
    )


def audio_part(raw: bytes, mime_type: str = "audio/wav") -> AudioInputContent:
    return AudioInputContent(
        source=InputContentDataSource(
            value=base64.b64encode(raw).decode(), mime_type=mime_type
        )
    )


def image_part(raw: bytes, mime_type: str = "image/png") -> ImageInputContent:
    return ImageInputContent(
        source=InputContentDataSource(
            value=base64.b64encode(raw).decode(), mime_type=mime_type
        )
    )


def ensure_audio_capable_sdk(monkeypatch: Any) -> None:
    """Make the adapter see an audio-capable Strands SDK.

    On an SDK that already ships the audio block this changes nothing, so the
    real capability probe is what runs. On an older SDK the probe is replaced
    with the formats the first audio-capable release declares.
    """
    if not utils._strands_audio_formats():
        monkeypatch.setattr(utils, "_strands_audio_formats", lambda: STRANDS_AUDIO_FORMATS)


def without_audio_sdk(monkeypatch: Any) -> None:
    """Make the adapter see a Strands SDK that predates the audio block."""
    monkeypatch.setattr(utils, "_strands_audio_formats", lambda: frozenset())


def sdk_has_audio() -> bool:
    """Whether the installed Strands SDK itself carries the audio block.

    A real ``Agent`` validates prompt blocks against its own ``ContentBlock``,
    so a test that drives one with audio needs the real capability, not the
    patched probe.
    """
    return bool(utils._strands_audio_formats())


# Reasons the adapter reports for an audio attachment it did not deliver.
AUDIO_SDK_REASON = "installed strands-agents does not support audio input (requires >= 1.53.0)"
AUDIO_MODEL_REASON = "configured model does not support audio input"


def audio_drop_reason() -> str:
    """The reason a model without audio input gets on the installed SDK.

    The SDK check runs first, so below 1.53 it is the one reported.
    """
    return AUDIO_MODEL_REASON if sdk_has_audio() else AUDIO_SDK_REASON


class _OfflineOpenAIStream:
    """A one-chunk chat-completions stream that answers in words."""

    def __init__(self, text: str):
        delta = SimpleNamespace(
            content=text, tool_calls=None, reasoning_content=None, reasoning=None
        )
        self._events = [
            SimpleNamespace(
                choices=[SimpleNamespace(delta=delta, finish_reason="stop")],
                usage=None,
            )
        ]

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        while self._events:
            yield self._events.pop(0)


def offline_openai_model(monkeypatch: Any, text: str = "heard it"):
    """A real ``OpenAIModel`` whose only missing piece is the network.

    ``format_request`` and the SDK's content formatter run for real, so a block
    OpenAI chat cannot carry raises the SDK's own ``TypeError`` exactly as it
    would in production. Only ``openai.AsyncOpenAI`` is replaced, with a client
    that records each request it is handed and streams back ``text``. Returns
    the model and that request list.
    """
    import openai
    from strands.models.openai import OpenAIModel

    requests: List[dict] = []

    class _OfflineClient:
        def __init__(self, **_client_args: Any) -> None:
            async def create(**request: Any) -> _OfflineOpenAIStream:
                requests.append(request)
                return _OfflineOpenAIStream(text)

            self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))

        async def __aenter__(self) -> "_OfflineClient":
            return self

        async def __aexit__(self, *_exc: Any) -> bool:
            return False

    monkeypatch.setattr(openai, "AsyncOpenAI", _OfflineClient)
    model = OpenAIModel(client_args={"api_key": "not-a-real-key"}, model_id="gpt-4o")
    return model, requests


def accepting_bedrock_model(text: str = "heard it"):
    """A real ``BedrockModel`` that formats every request and sends none.

    It stands in for a Bedrock model id that accepts audio input, which the
    adapter only sends audio to when ``audio_input_supported=True`` says so.
    Each call runs the SDK's own Bedrock message formatter over the history it
    is handed, records the result on ``formatted`` and the native history on
    ``calls``, then answers ``text``. The model id is a placeholder and the
    region one the boto3 client needs at construction; no credential is read
    and no call is made.
    """
    import copy

    from strands.models.bedrock import BedrockModel

    class _OfflineBedrockModel(BedrockModel):
        def __init__(self) -> None:
            super().__init__(model_id="example.audio-input-model-v1:0", region_name="us-east-1")
            self.calls: List[List[dict]] = []
            self.formatted: List[List[dict]] = []

        async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
            self.calls.append(copy.deepcopy(messages))
            self.formatted.append(self._format_bedrock_messages(messages))
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockDelta": {"delta": {"text": text}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}

    return _OfflineBedrockModel()


# The SDK's own default Bedrock model id from strands-agents 1.58: Claude
# Sonnet 4.6, whose Bedrock model card lists audio input as unsupported.
BEDROCK_MODEL_WITHOUT_AUDIO = "global.anthropic.claude-sonnet-4-6"


def _has_audio_block(value: Any) -> bool:
    if isinstance(value, dict):
        return "audio" in value or any(_has_audio_block(item) for item in value.values())
    if isinstance(value, list):
        return any(_has_audio_block(item) for item in value)
    return False


def rejecting_bedrock_model(text: str = "heard it", model_id: str = BEDROCK_MODEL_WITHOUT_AUDIO):
    """A real ``BedrockModel`` for a model id without audio input.

    Everything up to the wire is the SDK's own: ``stream``, ``format_request``
    and the error handling around the client call. Only the boto3 client's
    ``converse_stream`` and ``converse`` are replaced. Each records the request
    it is handed on ``model.requests``; one carrying an audio block raises the
    ``ClientError`` ``ValidationException`` Bedrock answers with, any other
    streams back ``text``.
    """
    from botocore.exceptions import ClientError
    from strands.models.bedrock import BedrockModel

    model = BedrockModel(model_id=model_id, region_name="us-east-1")
    model.requests = []

    def _refuse_audio(request: dict, operation: str) -> None:
        model.requests.append(request)
        if _has_audio_block(request.get("messages")):
            raise ClientError(
                {
                    "Error": {
                        "Code": "ValidationException",
                        "Message": "This model doesn't support the audio content block.",
                    }
                },
                operation,
            )

    def converse_stream(**request: Any) -> dict:
        _refuse_audio(request, "ConverseStream")
        return {
            "stream": [
                {"messageStart": {"role": "assistant"}},
                {"contentBlockDelta": {"delta": {"text": text}, "contentBlockIndex": 0}},
                {"contentBlockStop": {"contentBlockIndex": 0}},
                {"messageStop": {"stopReason": "end_turn"}},
                {
                    "metadata": {
                        "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                        "metrics": {"latencyMs": 1},
                    }
                },
            ]
        }

    def converse(**request: Any) -> dict:
        _refuse_audio(request, "Converse")
        return {
            "output": {"message": {"role": "assistant", "content": [{"text": text}]}},
            "stopReason": "end_turn",
            "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
            "metrics": {"latencyMs": 1},
        }

    model.client.converse_stream = converse_stream
    model.client.converse = converse
    return model
