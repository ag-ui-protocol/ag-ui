#!/usr/bin/env python
"""Interactive script to test multimodal messaging against a running ADK server.

Usage:
    python test_multimodal_live.py                          # text-only chat
    python test_multimodal_live.py --image photo.png        # send an image
    python test_multimodal_live.py --image photo.jpg --text "What's in this image?"
    python test_multimodal_live.py --url https://example.com/doc.pdf --text "Summarize this"

Requires the ADK server to be running on http://localhost:8000 (or set --server).
"""

import argparse
import base64
import json
import mimetypes
import sys
import uuid
from pathlib import Path

import httpx


def build_message(text: str, image_path: str | None, url: str | None) -> dict:
    """Build an AG-UI UserMessage with optional multimodal content."""
    content_parts = []

    if text:
        content_parts.append({"type": "text", "text": text})

    if image_path:
        path = Path(image_path)
        if not path.exists():
            print(f"Error: file not found: {image_path}", file=sys.stderr)
            sys.exit(1)

        mime_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        content_parts.append({
            "type": "image",
            "source": {
                "type": "data",
                "value": data,
                "mimeType": mime_type,
            },
        })
        print(f"  Attached image: {path.name} ({mime_type}, {len(data)} bytes base64)")

    if url:
        # Guess mime type from URL extension
        mime_type = mimetypes.guess_type(url)[0]
        content_parts.append({
            "type": "document",
            "source": {
                "type": "url",
                "value": url,
                **({"mimeType": mime_type} if mime_type else {}),
            },
        })
        print(f"  Attached URL: {url} ({mime_type or 'auto-detect'})")

    # If only text, send as plain string; otherwise send content array
    if len(content_parts) == 1 and content_parts[0]["type"] == "text":
        msg_content = text
    elif not content_parts:
        msg_content = text or "Hello"
    else:
        msg_content = content_parts

    return {
        "id": f"msg-{uuid.uuid4().hex[:8]}",
        "role": "user",
        "content": msg_content,
    }


def send_message(server_url: str, message: dict, thread_id: str):
    """Send a message to the ADK server and stream the response."""
    payload = {
        "threadId": thread_id,
        "runId": f"run-{uuid.uuid4().hex[:8]}",
        "messages": [message],
        "context": [],
        "state": {},
        "tools": [],
        "forwardedProps": {},
    }

    print(f"\n--- Sending to {server_url} (thread: {thread_id}) ---\n")

    with httpx.stream(
        "POST",
        server_url,
        json=payload,
        headers={"Accept": "text/event-stream"},
        timeout=60.0,
    ) as response:
        if response.status_code != 200:
            print(f"Error: HTTP {response.status_code}")
            print(response.read().decode())
            return

        full_text = []
        for line in response.iter_lines():
            if not line.strip():
                continue

            # Parse SSE format
            if line.startswith("data: "):
                data_str = line[6:]
                try:
                    event = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                event_type = event.get("type")

                if event_type == "TEXT_MESSAGE_CONTENT":
                    delta = event.get("delta", "")
                    print(delta, end="", flush=True)
                    full_text.append(delta)
                elif event_type == "RUN_STARTED":
                    print("[Run started]")
                elif event_type == "RUN_FINISHED":
                    print("\n[Run finished]")
                elif event_type == "RUN_ERROR":
                    print(f"\n[ERROR] {event.get('message', 'Unknown error')}")
                elif event_type == "TEXT_MESSAGE_START":
                    pass  # beginning of message
                elif event_type == "TEXT_MESSAGE_END":
                    pass  # end of message

        if full_text:
            print(f"\n\n--- Full response ({len(''.join(full_text))} chars) ---")


def main():
    parser = argparse.ArgumentParser(description="Test multimodal messaging against ADK server")
    parser.add_argument("--server", default="http://localhost:8000/chat/", help="Server endpoint URL")
    parser.add_argument("--text", "-t", default=None, help="Text message to send")
    parser.add_argument("--image", "-i", default=None, help="Path to an image file to attach")
    parser.add_argument("--url", "-u", default=None, help="URL of a document to attach")
    parser.add_argument("--thread", default=None, help="Thread ID (default: random)")
    parser.add_argument("--interactive", action="store_true", help="Interactive chat mode")
    args = parser.parse_args()

    thread_id = args.thread or f"thread-{uuid.uuid4().hex[:8]}"

    if args.interactive:
        print("Interactive multimodal chat (type 'quit' to exit)")
        print("  Prefix with /image <path> to attach an image")
        print("  Prefix with /url <url> to attach a document URL")
        print()

        while True:
            try:
                user_input = input("You: ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nBye!")
                break

            if user_input.lower() in ("quit", "exit", "/quit"):
                break

            image_path = None
            url = None
            text = user_input

            if user_input.startswith("/image "):
                parts = user_input[7:].split(" ", 1)
                image_path = parts[0]
                text = parts[1] if len(parts) > 1 else "Describe this image."

            elif user_input.startswith("/url "):
                parts = user_input[5:].split(" ", 1)
                url = parts[0]
                text = parts[1] if len(parts) > 1 else "What is this document about?"

            message = build_message(text, image_path, url)
            send_message(args.server, message, thread_id)
            print()
    else:
        if not args.text and not args.image and not args.url:
            args.text = "Hello! What can you help me with?"

        message = build_message(args.text or "", args.image, args.url)
        send_message(args.server, message, thread_id)


if __name__ == "__main__":
    main()
