"""The load-bearing gate for the whole park/resume design.

Everything in this integration's HITL design rests on one property of the Go
``localharness`` subprocess: it does **not** abandon a pending custom tool while
the Python side is parked and no consumer is reading the stream. The SDK source
proves only that *Python* has no timeout; the Go side is opaque, so this was
settled empirically -- and is re-checked here so an SDK upgrade that breaks it
fails loudly rather than silently hanging every HITL run in production.

Measured on google-antigravity 0.1.8: the harness survived 45 s and 180 s parks
and resumed correctly. This test uses a shorter default so it can run in CI;
raise it with PARK_SECONDS to reproduce the long soak.

    PARK_SECONDS=180 pytest tests/test_parking_gate.py -m live
"""

from __future__ import annotations

import asyncio
import os
import time

import pytest
from _live import config_kwargs, requires_gemini

pytestmark = [pytest.mark.live, requires_gemini]

PARK_SECONDS = float(os.environ.get("PARK_SECONDS", "30"))
SECRET = "octarine"


@pytest.mark.asyncio
async def test_harness_survives_a_park_with_no_consumer_attached(tmp_path):
    from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig
    from google.antigravity.hooks import policy

    parked = asyncio.Event()
    resume: asyncio.Future = asyncio.get_running_loop().create_future()

    async def lookup_favorite_color(user: str) -> str:
        """Looks up a user's favorite color. Returns the color name.

        Args:
          user: The user's name.
        """
        parked.set()
        return await resume

    config = LocalAgentConfig(
        **config_kwargs(),
        system_instructions=(
            "You must call the lookup_favorite_color tool to answer. "
            "After it returns, state the color verbatim in one short sentence."
        ),
        capabilities=CapabilitiesConfig(enable_subagents=False),
        policies=[policy.allow_all()],
        tools=[lookup_favorite_color],
        workspaces=[str(tmp_path)],
    )

    async with Agent(config) as agent:
        conversation = agent.conversation
        await conversation.send("What is Ada's favourite colour? Use the tool.")

        # ---- run N: read until the tool parks, then detach (SSE closes) ----
        async def consume():
            async for _ in conversation.receive_steps():
                pass

        reader = asyncio.create_task(consume())
        waiter = asyncio.create_task(parked.wait())
        await asyncio.wait({reader, waiter}, return_when=asyncio.FIRST_COMPLETED,
                           timeout=180)
        reader.cancel()
        try:
            await reader
        except asyncio.CancelledError:
            pass
        waiter.cancel()

        assert parked.is_set(), "the tool never parked; gate is inconclusive"

        # ---- the gap: nobody is reading the stream ----
        started = time.monotonic()
        await asyncio.sleep(PARK_SECONDS)

        # ---- run N+1: resolve and resume ----
        resume.set_result(SECRET)
        text = ""
        async for step in conversation.receive_steps():
            if step.content_delta:
                text += step.content_delta

        elapsed = time.monotonic() - started
        assert elapsed >= PARK_SECONDS
        assert SECRET in text.lower(), (
            f"harness did not resume after a {PARK_SECONDS}s park; got {text!r}"
        )
