"""Lossless live content conversion; original metadata stays in run input."""
import base64
import json
from typing import Any
from ._util import get

def plain(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_unset=True)
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    return value

def user_content(message: Any, *, preserve_blank_text: bool = False) -> list[dict[str, Any]]:
    content = get(message, "content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content.strip() else []
    blocks = []
    for raw in content or []:
        part = plain(raw)
        kind = part["type"]
        if kind == "text":
            blocks.append({"type": "text", "text": part["text"]})
            continue
        source = part.get("source", {})
        mime = part.get("mimeType") if kind == "binary" else source.get("mimeType")
        native_kind = ("image" if (mime or "").startswith("image/") else "document") if kind == "binary" else kind
        if native_kind not in ("image", "document"):
            continue
        allowed = ("image/png", "image/jpeg", "image/gif", "image/webp") if native_kind == "image" else ("application/pdf", "text/plain")
        if mime and mime not in allowed:
            continue
        if kind == "binary":
            if part.get("id"):
                native_source = {"type": "file", "file_id": part["id"]}
            elif part.get("url"):
                native_source = {"type": "url", "url": part["url"]}
            elif part.get("data") and mime:
                native_source = {"type": "base64", "data": part["data"], "media_type": mime}
            else:
                continue
        elif source.get("type") == "file" and source.get("provider") in (None, "anthropic"):
            native_source = {"type": "file", "file_id": source["value"]}
        elif source.get("type") == "url":
            native_source = {"type": "url", "url": source["value"]}
        elif source.get("type") == "data" and mime:
            native_source = {"type": "base64", "data": source["value"], "media_type": mime}
        else:
            continue
        if native_source["type"] == "base64" and mime == "text/plain":
            native_source = {"type": "text", "data": base64.b64decode(native_source["data"], validate=True).decode("utf-8"), "media_type": "text/plain"}
        block = {"type": native_kind, "source": native_source}
        metadata = part.get("metadata")
        filename = part.get("filename") if kind == "binary" else metadata.get("filename") if isinstance(metadata, dict) else None
        if native_kind == "document" and isinstance(filename, str):
            block["title"] = filename
        blocks.append(block)
    return blocks if preserve_blank_text or any(
        block["type"] != "text" or block["text"].strip() for block in blocks
    ) else []

def tool_content(content: Any, is_error: bool = False) -> Any:
    blocks = plain(content or [])
    if all(b.get("type") == "text" and isinstance(b.get("text"), str) and set(b) <= {"type", "text"} for b in blocks):
        text = "\n".join(b["text"] for b in blocks)
        return json.dumps({"error": True, "content": text}, ensure_ascii=False) if is_error else text
    parts = []
    for block in blocks:
        metadata = {"claudeManagedAgents": block, **({"isError": True} if is_error else {})}
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append({"type": "text", "text": block["text"], "metadata": metadata})
            continue
        source = block.get("source", {})
        native_source = None
        if isinstance(source, dict):
            if source.get("type") == "base64":
                native_source = {"type": "data", "value": source["data"], "mimeType": source["media_type"]}
            elif source.get("type") == "url":
                native_source = {"type": "url", "value": source["url"]}
            elif source.get("type") == "file":
                native_source = {"type": "file", "value": source["file_id"], "provider": "anthropic"}
        if block.get("type") in ("image", "document") and native_source:
            parts.append({"type": block["type"], "source": native_source, "metadata": metadata})
        else:
            parts.append({"type": "text", "text": json.dumps(block, ensure_ascii=False), "metadata": metadata})
    return parts
