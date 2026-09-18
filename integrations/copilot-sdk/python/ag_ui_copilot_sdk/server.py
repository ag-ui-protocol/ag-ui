"""Optional self-contained server: python -m ag_ui_copilot_sdk.server."""

import asyncio
import json
import os
from collections.abc import Callable
from contextlib import asynccontextmanager
from ipaddress import ip_address
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import urlparse

from ag_ui.encoder import EventEncoder
from copilot import CopilotClient
from copilot.tools import Tool
from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from .agent import CopilotAgent, InputError, ThreadConflict, ThreadContext, validate_input
from .fixture import FixtureClient

MAX_BYTES = 1_048_576
DEFAULT_INSTRUCTIONS = (
    "You are a helpful assistant. Use declared frontend tools when requested, "
    "and consume their real returned results. Never invent tool outputs."
)


def create_app(
    adapter: CopilotAgent | None = None,
    *,
    tools_factory: Callable[[ThreadContext], list[Tool]] | None = None,
    state_validator: Callable[[Any, Any], Any] | None = None,
    storage_directory: str | Path | None = None,
    instructions: str = DEFAULT_INSTRUCTIONS,
    client_factory: Callable[..., CopilotClient] | None = None,
) -> Starlette:
    mode = os.getenv("COPILOT_DEMO_MODE", "live")
    if mode not in ("live", "fixture"):
        raise ValueError("COPILOT_DEMO_MODE must be live or fixture")

    @asynccontextmanager
    async def lifespan(app):
        client = None
        runtime = None
        active_adapter = adapter
        try:
            if active_adapter is None:
                if mode == "fixture":
                    client = FixtureClient()
                else:
                    storage = Path(storage_directory) if storage_directory else Path(".runtime")
                    storage.mkdir(parents=True, exist_ok=True, mode=0o700)
                    runtime = TemporaryDirectory(prefix="sdk-", dir=storage)
                    client = (client_factory or CopilotClient)(
                        use_logged_in_user=True,
                        log_level="error",
                        mode="empty",
                        base_directory=str(Path(runtime.name).resolve()),
                    )
                await client.start()
                active_adapter = CopilotAgent(
                    client,
                    model=os.getenv("COPILOT_MODEL", "auto"),
                    tools_factory=tools_factory,
                    state_validator=state_validator,
                    instructions=instructions,
                )
            app.state.adapter = active_adapter
            yield
        finally:
            try:
                if active_adapter is not None:
                    await active_adapter.close()
            finally:
                try:
                    if client:
                        try:
                            await client.stop()
                        except Exception:  # noqa: BLE001
                            await client.force_stop()
                finally:
                    if runtime is not None:
                        runtime.cleanup()

    async def health(_request):
        return JSONResponse(
            {
                "status": "ok",
                "backend": "python",
                "sdk": "1.0.14",
                "mode": mode,
                "synthetic": mode == "fixture",
            }
        )

    async def agent(request: Request):
        is_cancel = request.url.path in ("/cancel", "/agent/cancel")
        max_bytes = 4096 if is_cancel else MAX_BYTES
        origin = request.headers.get("origin")
        if origin:
            parsed = urlparse(origin)
            if parsed.scheme != "http" or parsed.hostname not in (
                "localhost",
                "127.0.0.1",
            ):
                return JSONResponse({"error": "Origin forbidden"}, status_code=403)
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            return JSONResponse({"error": "Expected application/json"}, status_code=415)
        length = request.headers.get("content-length")
        if length:
            try:
                if int(length) < 0 or int(length) > max_bytes:
                    return JSONResponse({"error": "Request too large"}, status_code=413)
            except ValueError:
                return JSONResponse({"error": "Invalid Content-Length"}, status_code=400)
        body = bytearray()
        try:
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > max_bytes:
                    return JSONResponse({"error": "Request too large"}, status_code=413)
            payload = json.loads(body)
            if is_cancel:
                if (
                    not isinstance(payload, dict)
                    or set(payload) != {"threadId"}
                    or not isinstance(payload["threadId"], str)
                    or not 1 <= len(payload["threadId"]) <= 200
                ):
                    return JSONResponse({"error": "Invalid cancellation request"}, status_code=422)
                await request.app.state.adapter.cancel(payload["threadId"])
                return JSONResponse({"status": "cancelled"})
            value = validate_input(payload, max_bytes=MAX_BYTES)
        except (ValueError, ValidationError):
            return JSONResponse({"error": "Invalid RunAgentInput"}, status_code=422)
        except ClientDisconnect:
            return JSONResponse({"error": "Disconnected"}, status_code=400)
        stream = request.app.state.adapter.run(value)
        try:
            first = await anext(stream)
        except ThreadConflict as exc:
            await stream.aclose()
            return JSONResponse({"error": str(exc), "code": exc.code}, status_code=409)
        except (InputError, ValueError):
            await stream.aclose()
            return JSONResponse({"error": "Invalid turn or state"}, status_code=422)
        except Exception:  # noqa: BLE001 -- do not expose SDK diagnostics or credentials.
            await stream.aclose()
            return JSONResponse({"error": "Copilot unavailable"}, status_code=503)

        encoder = EventEncoder()

        async def encode():
            try:
                yield encoder.encode(first)
                async for event in stream:
                    yield encoder.encode(event)
            finally:
                # Starlette cancels this iterator on disconnect. Finish SDK cleanup even then.
                cleanup = asyncio.create_task(stream.aclose())
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    await cleanup
                    raise

        return StreamingResponse(
            encode(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    app = Starlette(
        routes=[
            Route("/health", health),
            Route("/agent", agent, methods=["POST"]),
            Route("/cancel", agent, methods=["POST"]),
            Route("/agent/cancel", agent, methods=["POST"]),
        ],
        lifespan=lifespan,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])
    if adapter:
        app.state.adapter = adapter
    return app


app = create_app()


def run_server(application: Starlette = app) -> None:
    import uvicorn

    host = os.getenv("HOST", "127.0.0.1")
    if host != "localhost":
        ip_address(host)
    port = int(os.getenv("PORT", "8123"))
    if not 1 <= port <= 65535:
        raise ValueError("PORT must be between 1 and 65535")
    uvicorn.run(application, host=host, port=port, log_level="warning")


def main() -> None:
    run_server()


if __name__ == "__main__":
    main()
