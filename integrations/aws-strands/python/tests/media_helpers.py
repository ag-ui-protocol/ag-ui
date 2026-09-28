"""Real media payloads and SDK audio capability helpers shared by tests."""

from __future__ import annotations

import base64
import io
import struct
import wave
import zlib
from typing import Any

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
