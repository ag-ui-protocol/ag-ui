"""Deterministic localhost provider exercised through the installed native SDK."""

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from anthropic import AsyncAnthropic
from ag_ui_claude_managed_agents import ManagedAgentsAgent, InMemorySessionStore
from ag_ui_claude_managed_agents.state import HEADER
from tests.test_agent import base_input

history = []
ready = threading.Event()
committed = threading.Event()


def persist(event):
    native = {
        **event,
        "id": f"evt_{len(history) + 1}",
        "session_id": "sesn_native",
        "session_thread_id": "thread_primary",
        "created_at": "2026-10-21T12:00:00Z",
        "processed_at": "2026-10-21T12:00:00Z",
    }
    history.append(native)
    return native


class Provider(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def json_response(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if "/events/stream" in self.path:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.flush()
            assert ready.wait(10)
            initial = next(
                json.loads(block["text"][len(HEADER) :])
                for e in history
                if e["type"] == "system.message"
                for block in e["content"]
                if block["text"].startswith(HEADER)
            )
            call = persist(
                {
                    "type": "agent.custom_tool_use",
                    "name": "ag_ui_update_state",
                    "input": {
                        "operation": "merge_patch",
                        "expectedRevision": initial["revision"],
                        "patch": {
                            "board": {
                                "count": initial["state"]["board"]["count"] + 1,
                                "obsolete": None,
                            }
                        },
                    },
                }
            )
            self.wfile.write(
                (
                    "event: agent.custom_tool_use\ndata: " + json.dumps(call) + "\n\n"
                ).encode()
            )
            self.wfile.flush()
            assert committed.wait(10)
            idle = persist(
                {"type": "session.status_idle", "stop_reason": {"type": "end_turn"}}
            )
            self.wfile.write(
                (
                    "event: session.status_idle\ndata: " + json.dumps(idle) + "\n\n"
                ).encode()
            )
            self.wfile.flush()
            self.close_connection = True
        elif "/threads" in self.path:
            self.json_response(
                {
                    "data": [
                        {
                            "id": "thread_primary",
                            "session_id": "sesn_native",
                            "parent_thread_id": None,
                        }
                    ],
                    "has_more": False,
                }
            )
        else:
            self.json_response({"id": "agent_1", "tools": []})

    def do_POST(self):
        body = json.loads(
            self.rfile.read(int(self.headers.get("content-length", 0))) or "{}"
        )
        batch = body.get("events", [])
        system_positions = [
            i for i, event in enumerate(batch) if event["type"] == "system.message"
        ]
        if system_positions and (
            len(system_positions) != 1
            or system_positions[0] != len(batch) - 1
            or len(batch) < 2
            or batch[-2]["type"]
            not in ("user.message", "user.custom_tool_result", "user.tool_result")
        ):
            self.json_response(
                {
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "message": "system.message must be unique, final, and follow a supported companion",
                    },
                },
                status=400,
            )
            return
        for e in batch:
            persist(e)
        self.json_response({"id": "sesn_native", "data": []})
        if any(e["type"] == "system.message" for e in body.get("events", [])):
            ready.set()
        if any(e["type"] == "user.custom_tool_result" for e in body.get("events", [])):
            committed.set()


async def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        async with AsyncAnthropic(
            api_key="local-test",
            base_url=f"http://127.0.0.1:{server.server_port}",
            max_retries=0,
        ) as client:
            store = InMemorySessionStore()
            agent = ManagedAgentsAgent(
                managed_agent_id="agent_1",
                environment_id="env_1",
                client=client,
                session_store=store,
            )
            events = [
                e.model_dump(mode="json", by_alias=True, exclude_none=True)
                async for e in agent.run(
                    base_input(
                        state={"board": {"count": 1, "obsolete": "remove"}},
                        context=[
                            {"description": "Board catalog", "value": "CounterCard"}
                        ],
                    )
                )
            ]
            print(json.dumps({"events": history, "agUiEvents": events}))
    finally:
        server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
