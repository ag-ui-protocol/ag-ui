"""Server-signed proof that a tool call was paused for approval by this server.

The resume is stateless: the paused call comes back in the request's own
history, which the client writes. So a call the model never made, or a paused
call with changed arguments, would look just like a real one. To tell them
apart, the server signs each call it pauses and puts the token on that call in
the MESSAGES_SNAPSHOT, under ``ToolCall.metadata["ag-ui"]["heldCall"]``. The
client keeps the snapshot as its history and sends it back, token included.
A resume entry runs a call only when its token verifies.

Token: ``base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, base64url(payload)))``.
The payload binds the signer's scope (the agent that paused the call), the
thread, the tool call id, the tool name and the SHA-256 of the arguments in
canonical form (see ``canonical_arguments``), and it
carries an expiry and a random nonce (``jti``). A resumed call runs on that
canonical form, so the tool gets exactly the text the token covers. A decided
token is consumed, so the same approval cannot run the call again. With
several workers, the record of decided tokens must be shared (see
``ConsumedTokens``).
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

DEFAULT_TTL_SECONDS = 15 * 60
"""How long an approval stays answerable by default.

It also bounds replay when decided tokens are kept per process: a replay that
reaches another worker, or comes after a restart, verifies until expiry.
Fifteen minutes is enough to decide one approval and keeps that window short.
Pass ``ttl_seconds`` for longer, together with a shared ``ConsumedTokens``.
"""
MIN_SECRET_BYTES = 32
_TOKEN_VERSION = 1


class ConsumedTokens(Protocol):
    """Where decided tokens are recorded, so a decision applies once.

    Give every worker of a deployment the same store (Redis, a database) to
    stop a replay that reaches a different worker or comes after a restart.
    Pass it as ``consumed_tokens=`` to ``OpenAIAgentsAgent`` or
    ``add_openai_agents_fastapi_endpoint``, or as ``consumed=`` to
    ``ApprovalSigner``. ``consume`` may be sync or async, and must be atomic
    across workers: for example Redis ``SET <token_id> 1 NX EXAT <expires_at>``,
    which tells you whether the key was new.
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
        ttl_seconds: How long an approval stays answerable. Defaults to 15
            minutes (``DEFAULT_TTL_SECONDS``).
        consumed: Where decided tokens are recorded. Defaults to a
            per-process store; with several workers pass a shared one.
        scope: The agent or endpoint whose calls this signer pauses. A token
            verifies only under the scope that issued it, so one agent's
            approval cannot run another agent's tool of the same name. Use the
            same scope on every worker serving one agent, and a different one
            for each agent that shares the secret. ``OpenAIAgentsAgent`` sets
            it (see its ``approval_scope``). A signer without a scope cannot
            issue a token and verifies none: give it one with ``scoped``.
    """

    def __init__(
        self,
        secret: bytes | str,
        *,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        consumed: ConsumedTokens | None = None,
        scope: str = "",
    ) -> None:
        key = secret.encode() if isinstance(secret, str) else bytes(secret)
        if len(key) < MIN_SECRET_BYTES:
            raise ValueError(f"The approval secret must be at least {MIN_SECRET_BYTES} bytes.")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive.")
        self._key = key
        self._ttl = ttl_seconds
        self._consumed = consumed if consumed is not None else InMemoryConsumedTokens()
        self._scope = scope

    @property
    def scope(self) -> str:
        """The scope this signer's tokens are bound to."""
        return self._scope

    def scoped(self, scope: str) -> ApprovalSigner:
        """This signer, with the same secret, TTL and store, bound to ``scope``."""
        if scope == self._scope:
            return self
        return ApprovalSigner(self._key, ttl_seconds=self._ttl, consumed=self._consumed, scope=scope)

    def issue(self, thread_id: str, call: ToolCall) -> str:
        """A token for ``call``, paused in thread ``thread_id``.

        Raises:
            ValueError: This signer has no scope.
        """
        if not self._scope:
            raise ValueError(
                "A tool approval can only be paused by a signer with a scope, so that "
                "no other agent can run the call. Pass approvals=signer.scoped(agent.name) "
                "(for example default_approval_signer().scoped(agent.name)) to both "
                "to_agui and resume_tool_calls, or serve the agent with OpenAIAgentsAgent, "
                "which sets one."
            )
        payload = {
            "v": _TOKEN_VERSION,
            "aud": self._scope,
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
        secret, issued under another scope or for another thread, call id,
        tool name or arguments, or expired. Always None when this signer has
        no scope.
        """
        if not self._scope:
            return None
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
            or payload.get("aud") != self._scope
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
        """Record a decision on ``held``. False when one was already recorded.

        Also False once ``held`` has expired, checked again after the store
        answers: the record of a decided token may be dropped at expiry, so an
        expired token would otherwise count as new. ``verify`` checks expiry
        too, but resumed tools run in turn, so a token can expire between its
        ``verify`` and its ``consume``.
        """
        if held.expires_at <= time.time():
            return False
        result = self._consumed.consume(held.token_id, held.expires_at)
        if inspect.isawaitable(result):
            result = await result
        return bool(result) and held.expires_at > time.time()

    def _sign(self, body: str) -> bytes:
        return hmac.new(self._key, body.encode(), hashlib.sha256).digest()


def held_call_token(call: ToolCall) -> Any:
    """The token on ``call``'s metadata, or None."""
    metadata = call.metadata if isinstance(call.metadata, dict) else {}
    reserved = metadata.get(AGUI_METADATA_KEY)
    return reserved.get(HELD_CALL_KEY) if isinstance(reserved, dict) else None


_default: ApprovalSigner | None = None
_default_lock = threading.Lock()
_process_secret: bytes | None = None


def default_approval_signer(*, consumed: ConsumedTokens | None = None) -> ApprovalSigner:
    """The signer used when none is passed, without a scope.

    It neither issues nor verifies tokens until it is given a scope with
    ``scoped`` (``OpenAIAgentsAgent`` does this). Its secret comes from ``AG_UI_OPENAI_AGENTS_APPROVAL_SECRET``. Without it,
    a random secret is made for this process: approvals then only resume on
    the process that paused them, and not after a restart.

    Args:
        consumed: Where decided tokens are recorded. Without it, the one
            per-process signer is returned and decided tokens are kept in
            process memory, so a replay that reaches another worker, or comes
            after a restart, runs the call again until the token expires. With
            it, a new signer with the same secret and this store is returned.
    """
    global _default
    with _default_lock:
        if consumed is not None:
            return ApprovalSigner(_secret(), consumed=consumed)
        if _default is None:
            if os.environ.get(SECRET_ENV):
                logger.warning(
                    "%s is set but decided tool approvals are kept in an in-memory, "
                    "per-process store; a replayed approval that reaches another worker "
                    "or comes after a restart runs the tool again until the token "
                    "expires. Pass a shared consumed_tokens store when running more "
                    "than one worker",
                    SECRET_ENV,
                )
            _default = ApprovalSigner(_secret())
        return _default


def _secret() -> bytes | str:
    """The configured secret, or this process's random one. Call under ``_default_lock``."""
    global _process_secret
    secret = os.environ.get(SECRET_ENV)
    if secret:
        return secret
    if _process_secret is None:
        logger.warning(
            "%s is not set; tool approvals are signed with a random per-process "
            "secret and only resume on this process",
            SECRET_ENV,
        )
        _process_secret = secrets.token_bytes(MIN_SECRET_BYTES)
    return _process_secret


def canonical_arguments(arguments: str | None) -> str:
    """The text of ``arguments`` that a token covers and a resumed tool runs on.

    JSON is written again with sorted keys, no spaces and ASCII escapes, so a
    duplicate key keeps one value and the tool reads the arguments the way
    the hash did. Text that is not JSON, or JSON with a number that does not
    survive the round trip (``1e400`` and ``1e999`` both read as infinity),
    is kept exactly as sent.
    """
    return _canonical(arguments)[0]


def _canonical(arguments: str | None) -> tuple[str, bool]:
    """``canonical_arguments``, and whether it is re-encoded JSON."""
    text = arguments or "{}"
    try:
        return (
            json.dumps(
                json.loads(text),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
                allow_nan=False,
            ),
            True,
        )
    except (ValueError, RecursionError):
        return text, False


def _arguments_hash(arguments: str | None) -> str:
    """SHA-256 of ``canonical_arguments``; text kept as sent is marked apart."""
    text, is_json = _canonical(arguments)
    if not is_json:
        text = "raw:" + text
    # A lone surrogate is a valid str but not valid UTF-8: hash it, never crash.
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


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
    "canonical_arguments",
    "default_approval_signer",
    "held_call_token",
]
