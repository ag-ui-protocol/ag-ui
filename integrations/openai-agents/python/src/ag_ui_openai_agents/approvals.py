"""Server-signed proof that a tool call was paused for approval by this server.

The resume is stateless: the paused call comes back in the request's own
history, which the client writes. So a call the model never made, or a paused
call with changed arguments, would look just like a real one. To tell them
apart, the server signs each call it pauses and puts the token on that call in
the MESSAGES_SNAPSHOT, under ``ToolCall.metadata["ag-ui"]["heldCall"]``. The
client keeps the snapshot as its history and sends it back, token included.
A resume entry runs a call only when its token verifies.

Token: ``base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, base64url(payload)))``.
The payload binds the thread, the tool call id, the tool name and the SHA-256
of the canonical JSON of the arguments, and it carries an expiry and a random
nonce (``jti``). A decided token is consumed, so the same approval cannot run
the call again.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import inspect
import json
import logging
import os
import secrets
import threading
import time
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any, Protocol

from ag_ui.core import ToolCall

logger = logging.getLogger(__name__)

AGUI_METADATA_KEY = "ag-ui"
"""The metadata key AG-UI reserves for its own use."""

HELD_CALL_KEY = "heldCall"
"""Key of the token under ``ToolCall.metadata["ag-ui"]``."""

SECRET_ENV = "AG_UI_OPENAI_AGENTS_APPROVAL_SECRET"
"""Environment variable the default signer reads its secret from."""

DEFAULT_TTL_SECONDS = 3600
MIN_SECRET_BYTES = 32
_TOKEN_VERSION = 1


class ConsumedTokens(Protocol):
    """Where decided tokens are recorded, so a decision applies once.

    Give every worker of a deployment the same store (Redis, a database) to
    stop a replay that reaches a different worker.
    """

    def consume(self, token_id: str, expires_at: float) -> bool | Awaitable[bool]:
        """Record ``token_id``. Return False when it was already recorded.

        ``expires_at`` (epoch seconds) is when the token stops verifying; the
        record may be dropped after it.
        """
        ...


class InMemoryConsumedTokens:
    """A per-process ``ConsumedTokens``; records drop when their token expires."""

    def __init__(self) -> None:
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def consume(self, token_id: str, expires_at: float) -> bool:
        now = time.time()
        with self._lock:
            for key in [key for key, exp in self._seen.items() if exp <= now]:
                del self._seen[key]
            if token_id in self._seen:
                return False
            self._seen[token_id] = expires_at
            return True


@dataclass(frozen=True)
class HeldCall:
    """A verified token: the replay key and when it expires."""

    token_id: str
    expires_at: float


class ApprovalSigner:
    """Signs the tool calls a run pauses for approval, and verifies them on resume.

    Args:
        secret: At least 32 bytes (UTF-8 bytes for a string). Every worker that
            may receive the resume needs the same secret.
        ttl_seconds: How long an approval stays answerable. Defaults to an hour.
        consumed: Where decided tokens are recorded. Defaults to a
            per-process store.
    """

    def __init__(
        self,
        secret: bytes | str,
        *,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        consumed: ConsumedTokens | None = None,
    ) -> None:
        key = secret.encode() if isinstance(secret, str) else bytes(secret)
        if len(key) < MIN_SECRET_BYTES:
            raise ValueError(f"The approval secret must be at least {MIN_SECRET_BYTES} bytes.")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive.")
        self._key = key
        self._ttl = ttl_seconds
        self._consumed = consumed if consumed is not None else InMemoryConsumedTokens()

    def issue(self, thread_id: str, call: ToolCall) -> str:
        """A token for ``call``, paused in thread ``thread_id``."""
        payload = {
            "v": _TOKEN_VERSION,
            "tid": thread_id,
            "tcid": call.id,
            "name": call.function.name,
            "ah": _arguments_hash(call.function.arguments),
            "exp": int(time.time()) + self._ttl,
            "jti": secrets.token_urlsafe(16),
        }
        body = _b64(json.dumps(payload, separators=(",", ":")).encode())
        return f"{body}.{_b64(self._sign(body))}"

    def hold(self, thread_id: str, call: ToolCall) -> ToolCall:
        """``call`` with a fresh token in its metadata."""
        metadata = dict(call.metadata or {})
        reserved = metadata.get(AGUI_METADATA_KEY)
        reserved = dict(reserved) if isinstance(reserved, dict) else {}
        reserved[HELD_CALL_KEY] = self.issue(thread_id, call)
        metadata[AGUI_METADATA_KEY] = reserved
        return call.model_copy(update={"metadata": metadata})

    def verify(self, thread_id: str, call: ToolCall) -> HeldCall | None:
        """The token on ``call`` if this server issued it for exactly this call.

        Returns None when the token is missing, malformed, signed with another
        secret, issued for another thread, call id, tool name or arguments, or
        expired.
        """
        token = held_call_token(call)
        if not isinstance(token, str) or token.count(".") != 1:
            return None
        body, signature = token.split(".")
        given = _unb64(signature)
        if given is None or not hmac.compare_digest(given, self._sign(body)):
            return None
        raw = _unb64(body)
        try:
            payload = json.loads(raw) if raw is not None else None
        except ValueError:
            return None
        if not isinstance(payload, dict):
            return None
        expires_at = payload.get("exp")
        if (
            payload.get("v") != _TOKEN_VERSION
            or payload.get("tid") != thread_id
            or payload.get("tcid") != call.id
            or payload.get("name") != call.function.name
            or payload.get("ah") != _arguments_hash(call.function.arguments)
            or not isinstance(expires_at, int)
            or isinstance(expires_at, bool)
            or expires_at <= time.time()
            or not isinstance(payload.get("jti"), str)
        ):
            return None
        return HeldCall(token_id=payload["jti"], expires_at=float(expires_at))

    async def consume(self, held: HeldCall) -> bool:
        """Record a decision on ``held``. False when one was already recorded."""
        result = self._consumed.consume(held.token_id, held.expires_at)
        if inspect.isawaitable(result):
            result = await result
        return bool(result)

    def _sign(self, body: str) -> bytes:
        return hmac.new(self._key, body.encode(), hashlib.sha256).digest()


def held_call_token(call: ToolCall) -> Any:
    """The token on ``call``'s metadata, or None."""
    metadata = call.metadata if isinstance(call.metadata, dict) else {}
    reserved = metadata.get(AGUI_METADATA_KEY)
    return reserved.get(HELD_CALL_KEY) if isinstance(reserved, dict) else None


_default: ApprovalSigner | None = None
_default_lock = threading.Lock()


def default_approval_signer() -> ApprovalSigner:
    """The signer used when none is passed.

    Its secret comes from ``AG_UI_OPENAI_AGENTS_APPROVAL_SECRET``. Without it,
    a random secret is made for this process: approvals then only resume on
    the process that paused them, and not after a restart.
    """
    global _default
    with _default_lock:
        if _default is None:
            secret = os.environ.get(SECRET_ENV)
            if not secret:
                logger.warning(
                    "%s is not set; tool approvals are signed with a random per-process "
                    "secret and only resume on this process",
                    SECRET_ENV,
                )
                secret = secrets.token_bytes(MIN_SECRET_BYTES)
            _default = ApprovalSigner(secret)
        return _default


def _arguments_hash(arguments: str | None) -> str:
    """SHA-256 of the canonical JSON of the arguments (the raw text if not JSON)."""
    text = arguments or "{}"
    try:
        text = json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    except ValueError:
        text = "raw:" + text
    return hashlib.sha256(text.encode()).hexdigest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(segment: str) -> bytes | None:
    try:
        data = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
    except (ValueError, TypeError):
        return None
    # Canonical encoding only, so one token has one spelling.
    return data if _b64(data) == segment else None


__all__ = [
    "ApprovalSigner",
    "ConsumedTokens",
    "HeldCall",
    "InMemoryConsumedTokens",
    "HELD_CALL_KEY",
    "SECRET_ENV",
    "default_approval_signer",
    "held_call_token",
]
