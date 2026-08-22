"""Utility functions for AWS Strands integration."""

import base64
import ipaddress
import logging
import re
import socket
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set
from urllib.parse import quote, urlsplit, urlunsplit

from ag_ui.core import (
    AudioInputContent,
    BinaryInputContent,
    DocumentInputContent,
    ImageInputContent,
    TextInputContent,
    VideoInputContent,
)
from ag_ui.core.types import InputContentDataSource, InputContentUrlSource

logger = logging.getLogger(__name__)

# Allowed formats per media type for Strands ContentBlock
_IMAGE_FORMATS: Set[str] = {"png", "jpeg", "gif", "webp"}
_DOCUMENT_FORMATS: Set[str] = {"pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"}
_VIDEO_FORMATS: Set[str] = {"flv", "mkv", "mov", "mpeg", "mpg", "mp4", "three_gp", "webm", "wmv"}


# Common MIME subtype aliases that don't directly match the allowed format strings.
# e.g. "text/plain" splits to "plain" but the allowed format is "txt".
_MIME_FORMAT_ALIASES: Dict[str, str] = {
    "plain": "txt",
    "x-markdown": "md",
    "markdown": "md",
    "jpg": "jpeg",
    "msword": "doc",
    "vnd.ms-excel": "xls",
    "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}


def _mime_to_format(mime_type: Optional[str], allowed: Set[str]) -> Optional[str]:
    """Parse a MIME type into a short format string.

    For example ``"image/png"`` -> ``"png"``, ``"application/pdf"`` -> ``"pdf"``.
    Returns ``None`` if *mime_type* is absent or the parsed format is not in
    *allowed* — callers should skip the content block rather than guess.
    """
    if not mime_type:
        logger.warning("No MIME type provided, cannot determine format")
        return None
    # Strip MIME parameters (e.g. "; charset=utf-8") before parsing the subtype
    fmt = mime_type.split(";", 1)[0].strip().rsplit("/", 1)[-1].lower()
    # Resolve well-known aliases before checking the allowed set
    fmt = _MIME_FORMAT_ALIASES.get(fmt, fmt)
    if fmt in allowed:
        return fmt
    logger.warning(
        "Unsupported MIME type '%s' (parsed format '%s' not in %s)",
        mime_type,
        fmt,
        sorted(allowed),
    )
    return None


class UrlFetchPolicyError(Exception):
    """Raised when a URL is rejected by the fetch policy (scheme or network range)."""


@dataclass(frozen=True)
class UrlFetchPolicy:
    """Policy applied to every server-side URL fetch.

    The defaults are deliberately restrictive: only ``http``/``https`` are
    fetched, addresses outside the public internet (loopback, private,
    link-local — notably the ``169.254.169.254`` cloud metadata endpoint —
    multicast and reserved ranges) are refused, and the response body is
    capped.  Relaxing address checks is opt-in by passing a custom policy, but
    link-local ranges (including common cloud metadata endpoints) remain
    blocked.
    """

    allowed_schemes: frozenset = field(default_factory=lambda: frozenset({"http", "https"}))
    allow_private_networks: bool = False
    max_bytes: int = 25 * 1024 * 1024
    timeout: float = 30.0


DEFAULT_URL_FETCH_POLICY = UrlFetchPolicy()


def _is_blocked_address(
    ip: "ipaddress._BaseAddress", allow_private_networks: bool = False
) -> bool:
    """Return ``True`` for any address that must not be reached server-side."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    # Cloud metadata and other link-local services are never legitimate URL
    # content sources, even when an application opts into its private network.
    if ip.is_link_local:
        return True
    if allow_private_networks:
        return False
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or not ip.is_global
    )


def _resolved_addresses(host: str, port: Optional[int]) -> List["ipaddress._BaseAddress"]:
    """Resolve *host* to IP addresses, accepting IP literals as-is."""
    literal = host.strip("[]")
    try:
        return [ipaddress.ip_address(literal)]
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise UrlFetchPolicyError(f"Cannot resolve host '{host}': {exc}") from exc
    addresses = []
    for info in infos:
        try:
            addresses.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    if not addresses:
        raise UrlFetchPolicyError(f"Cannot resolve host '{host}' to an IP address")
    return addresses


def _validate_fetch_url(url: str, policy: Optional[UrlFetchPolicy] = None) -> None:
    """Validate *url* against *policy*; raise :class:`UrlFetchPolicyError` if refused."""
    policy = policy or DEFAULT_URL_FETCH_POLICY
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()
    if scheme not in policy.allowed_schemes:
        raise UrlFetchPolicyError(
            f"URL scheme '{scheme}' is not allowed "
            f"(allowed: {sorted(policy.allowed_schemes)})"
        )
    host = parts.hostname
    if not host:
        # Explicitly allowed non-network schemes (for example ``data``) have no
        # host. Requiring both scheme and private-network opt-ins preserves that
        # escape hatch without weakening the default policy.
        if policy.allow_private_networks:
            return
        raise UrlFetchPolicyError(f"URL has no host: {url}")
    for ip in _resolved_addresses(host, parts.port):
        if _is_blocked_address(ip, policy.allow_private_networks):
            raise UrlFetchPolicyError(
                f"URL host '{host}' resolves to non-public address {ip}, "
                "which is blocked by the URL fetch policy"
            )


class _PolicyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-applies the fetch policy to every redirect target."""

    def __init__(self, policy: UrlFetchPolicy):
        self._policy = policy

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_fetch_url(newurl, self._policy)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open_url(url: str, timeout: float, policy: UrlFetchPolicy):
    """Open *url* with a redirect handler that re-validates every hop."""
    opener = urllib.request.build_opener(_PolicyRedirectHandler(policy))
    return opener.open(url, timeout=timeout)


def _fetch_url_bytes(url: str, policy: Optional[UrlFetchPolicy] = None) -> Optional[bytes]:
    """Fetch raw bytes from *url* using :mod:`urllib`.

    The URL is validated against *policy* (default:
    :data:`DEFAULT_URL_FETCH_POLICY`) before any request is made and again on
    every redirect hop, so ``file://`` reads and requests to private,
    loopback or cloud-metadata addresses are refused.  The response body is
    capped at ``policy.max_bytes``.

    Non-ASCII characters in the URL path (e.g. CJK filenames) are
    percent-encoded before the request to avoid ``UnicodeEncodeError``.

    Returns ``None`` on any failure (policy violation, network error,
    timeout, oversized body); the reason is logged.
    """
    policy = policy or DEFAULT_URL_FETCH_POLICY
    try:
        _validate_fetch_url(url, policy)
        parts = urlsplit(url)
        # Percent-encode non-ASCII chars in the path; preserve already-valid URL chars.
        # '%' is kept in safe= so that existing percent-encoded sequences (e.g. %20,
        # %2F in presigned URLs) are not double-encoded.  The trade-off is that a
        # literal '%' not followed by two hex digits (e.g. "50%.txt") also passes
        # through unescaped — the re.sub below fixes those up into valid %25 escapes.
        encoded_path = quote(parts.path, safe="/:@!$&'()*+,;=-._~%")
        encoded_path = re.sub(r"%(?![0-9A-Fa-f]{2})", "%25", encoded_path)
        # Apply the same encoding to the query string for non-ASCII values.
        # RFC 3986 allows these characters unencoded in a query component, so they
        # must stay in safe= to avoid rewriting presigned URLs (S3/Azure/GCS) or
        # breaking servers that distinguish encoded vs literal separators.
        encoded_query = quote(parts.query, safe="/:@!$&'()*+,;=-._~?%") if parts.query else ""
        encoded_query = re.sub(r"%(?![0-9A-Fa-f]{2})", "%25", encoded_query) if encoded_query else ""
        safe_url = urlunsplit((
            parts.scheme, parts.netloc, encoded_path,
            encoded_query, parts.fragment,
        ))
        with _open_url(safe_url, policy.timeout, policy) as resp:
            # Bounded read: one byte past the cap tells us the body was too big.
            data = resp.read(policy.max_bytes + 1)
        if len(data) > policy.max_bytes:
            logger.error(
                "Refusing to fetch URL %s: response exceeds the %d byte limit",
                url,
                policy.max_bytes,
            )
            return None
        return data
    except UrlFetchPolicyError as exc:
        logger.error("Refusing to fetch URL %s: %s", url, exc)
        return None
    except Exception as exc:
        logger.warning("Failed to fetch URL %s: %s", url, exc)
        return None


def _get_mime_type(source: Any) -> Optional[str]:
    """Extract ``mime_type`` from a source object if the attribute exists."""
    return getattr(source, "mime_type", None)


def _resolve_source_bytes(source: Any) -> Optional[bytes]:
    """Resolve bytes from an AG-UI content source.

    * :class:`InputContentDataSource` -- base64-decode ``source.value``.
    * :class:`InputContentUrlSource` -- fetch bytes via :func:`_fetch_url_bytes`.
    """
    if isinstance(source, InputContentDataSource):
        try:
            return base64.b64decode(source.value)
        except Exception as e:
            logger.warning(f"Failed to decode base64 content: {e}")
            return None
    if isinstance(source, InputContentUrlSource):
        return _fetch_url_bytes(source.value)
    logger.warning(f"Unknown content source type: {type(source).__name__}, cannot resolve bytes")
    return None


def convert_agui_content_to_strands(content: List[Any]) -> List[Dict[str, Any]]:
    """Convert an AG-UI ``InputContent`` list to Strands ``ContentBlock`` dicts.

    Supported content types:

    * :class:`TextInputContent` -> ``{"text": "..."}``
    * :class:`ImageInputContent` -> ``{"image": {"format": ..., "source": {"bytes": ...}}}``
    * :class:`DocumentInputContent` -> ``{"document": {"format": ..., "name": "document", "source": {"bytes": ...}}}``
    * :class:`VideoInputContent` -> ``{"video": {"format": ..., "source": {"bytes": ...}}}``
    * :class:`AudioInputContent` -- skipped with a warning (Strands has no audio support).
    * Unknown types -- skipped with a warning.
    """
    blocks: List[Dict[str, Any]] = []

    for item in content:
        if isinstance(item, TextInputContent):
            blocks.append({"text": item.text})

        elif isinstance(item, ImageInputContent):
            raw = _resolve_source_bytes(item.source)
            if raw is None:
                continue
            fmt = _mime_to_format(_get_mime_type(item.source), _IMAGE_FORMATS)
            if fmt is None:
                continue
            blocks.append({
                "image": {
                    "format": fmt,
                    "source": {"bytes": raw},
                }
            })

        elif isinstance(item, DocumentInputContent):
            raw = _resolve_source_bytes(item.source)
            if raw is None:
                continue
            fmt = _mime_to_format(_get_mime_type(item.source), _DOCUMENT_FORMATS)
            if fmt is None:
                continue
            blocks.append({
                "document": {
                    "format": fmt,
                    "name": "document",
                    "source": {"bytes": raw},
                }
            })

        elif isinstance(item, VideoInputContent):
            raw = _resolve_source_bytes(item.source)
            if raw is None:
                continue
            fmt = _mime_to_format(_get_mime_type(item.source), _VIDEO_FORMATS)
            if fmt is None:
                continue
            blocks.append({
                "video": {
                    "format": fmt,
                    "source": {"bytes": raw},
                }
            })

        elif isinstance(item, AudioInputContent):
            logger.warning(
                "Skipping audio content block: Strands does not support audio input."
            )

        elif isinstance(item, BinaryInputContent):
            # Deprecated type — attempt to map to image block
            raw_bytes = None
            if item.data:
                try:
                    raw_bytes = base64.b64decode(item.data)
                except Exception:
                    logger.warning("Skipping binary content: invalid base64 data")
                    continue
            elif item.url:
                raw_bytes = _fetch_url_bytes(item.url)
            if raw_bytes is None:
                logger.warning("Skipping binary content: could not resolve bytes")
                continue
            fmt = _mime_to_format(item.mime_type, _IMAGE_FORMATS)
            if fmt is None:
                logger.warning("Skipping binary content: unsupported MIME type '%s'", item.mime_type)
                continue
            blocks.append({
                "image": {
                    "format": fmt,
                    "source": {"bytes": raw_bytes},
                }
            })

        else:
            logger.warning("Skipping unknown content type: %s", type(item).__name__)

    # Bedrock rejects a message that contains document blocks but no text block.
    if any("document" in b for b in blocks) and not any("text" in b for b in blocks):
        blocks.insert(0, {"text": " "})

    return blocks


def flatten_content_to_text(content: Any) -> str:
    """Extract plain text from AG-UI message content.

    * If *content* is a ``str``, return it as-is.
    * If *content* is a ``list``, join all :class:`TextInputContent` ``.text``
      values with spaces.
    * If *content* is ``None``, return ``""``.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            item.text
            for item in content
            if isinstance(item, TextInputContent)
        ]
        return " ".join(parts)
    return ""


def create_strands_app(
    agent: "Any",
    path: str = "/",
    ping_path: str | None = "/ping",
    origins: Optional[List[str]] = None,
) -> "Any":
    """Create a FastAPI app with a single Strands agent endpoint and optional ping endpoint.

    Args:
        agent: The StrandsAgent instance
        path: Path for the agent endpoint (default: "/")
        ping_path: Path for the ping endpoint (default: "/ping"). Pass None to disable.
        origins: Allowed CORS origins. Defaults to ``["*"]`` (wildcard) for local
            development. Credentials are only enabled when explicit, non-wildcard
            origins are supplied — a wildcard origin can never be combined with
            ``allow_credentials=True``.
    """
    from fastapi import FastAPI
    from .endpoint import add_strands_fastapi_endpoint, add_ping

    app = FastAPI(title=f"AWS Strands - {agent.name}")

    # Add CORS middleware
    from fastapi.middleware.cors import CORSMiddleware
    cors_origins = origins or ["*"]
    is_wildcard = "*" in cors_origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=bool(origins) and not is_wildcard,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Add the agent endpoint
    add_strands_fastapi_endpoint(app, agent, path)

    # Add ping endpoint if path is provided
    if ping_path is not None:
        add_ping(app, ping_path)

    return app
