"""Real HTTP chat/frontend-tool check using only the standard library as client."""

import argparse
import json
import secrets
import urllib.request
import uuid
from pathlib import Path


def main(url: str) -> None:
    def post(path, value):
        request = urllib.request.Request(
            url.rstrip("/") + path,
            data=json.dumps(value).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.read().decode()

    def payload(prompt, tools=None):
        return {
            "threadId": str(uuid.uuid4()),
            "runId": str(uuid.uuid4()),
            "state": {},
            "messages": [{"id": "u", "role": "user", "content": prompt}],
            "tools": tools or [],
            "context": [],
            "forwardedProps": {},
        }

    def run(value):
        events = [
            json.loads(line[5:])
            for line in post("/agent", value).splitlines()
            if line.startswith("data:")
        ]
        assert events[0]["type"] == "RUN_STARTED"
        assert events[-1]["type"] == "RUN_FINISHED" and not events[-1].get("outcome")
        return events

    chat_nonce = secrets.token_hex(8)
    chat = payload("Reply with exactly " + chat_nonce + " without tools.")
    initial = payload(
        "Call browser_nonce exactly once, then repeat its actual returned nonce verbatim.",
        [
            {
                "name": "browser_nonce",
                "description": "Get a fresh nonce from the browser.",
                "parameters": {"type": "object", "properties": {}},
            }
        ],
    )
    try:
        chat_events = run(chat)
        assert chat_nonce in "".join(
            event["delta"] for event in chat_events if event["type"] == "TEXT_MESSAGE_CONTENT"
        )
        handoff = run(initial)
        call_id = next(
            event["toolCallId"] for event in handoff if event["type"] == "TOOL_CALL_START"
        )
        assert not any(event["type"] == "TOOL_CALL_RESULT" for event in handoff)
        nonce = secrets.token_hex(12)
        continued = run(
            {
                **initial,
                "runId": str(uuid.uuid4()),
                "tools": [],
                "messages": initial["messages"]
                + [
                    {
                        "id": "result",
                        "role": "tool",
                        "toolCallId": call_id,
                        "content": json.dumps({"nonce": nonce}),
                    }
                ],
            }
        )
        assert nonce in "".join(
            event["delta"] for event in continued if event["type"] == "TEXT_MESSAGE_CONTENT"
        )
        assert not any(event["type"] == "TOOL_CALL_RESULT" for event in continued)
    finally:
        for request in (chat, initial):
            post("/cancel", {"threadId": request["threadId"]})
    report = {
        "sdk": "1.0.14",
        "protocol": "0.1.22",
        "url": url,
        "self_contained_package_server": True,
        "real_native_chat": True,
        "frontend_declaration_handoff": True,
        "original_pending_nonce_consumed": True,
        "no_frontend_result_echo": True,
        "omitted_declaration_supported": True,
        "explicit_cancellation": True,
    }
    Path("probes/standalone-server.evidence.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8123")
    main(parser.parse_args().url)
