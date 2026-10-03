"""Keyless "replay" model: a real ADK LiteLlm whose network call is replaced.

It streams a write_document tool call the way OpenAI/Anthropic do (name first,
then small argument fragments, with a small delay between chunks), so the whole
path — ADK Runner (SSE) -> ag_ui_adk -> AG-UI SSE -> webapp — can be verified
without a provider that streams function-call args. Use E2E_MODEL=replay.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncIterator

from google.adk.models.lite_llm import LiteLlm, LiteLLMClient
from litellm.types.utils import (
    ChatCompletionDeltaToolCall,
    Delta,
    Function,
    ModelResponseStream,
    StreamingChoices,
)

CHUNK_DELAY_S = float(os.getenv("REPLAY_CHUNK_DELAY_S", "0.03"))

DOCUMENT = {
    "title": "Backend Engineer Onboarding Guide",
    "content": "\n\n".join(
        [
            "# Backend Engineer Onboarding Guide",
            "Welcome aboard! This guide walks you through your first month.",
            "## Week 1 - Access and local setup\nGet GitHub, cloud and Slack access, "
            "then run the core services locally with Docker Compose.",
            "## Weeks 2-3 - Architecture and first PR\nRead the ADRs, pick a "
            '"good first issue" and ship it through CI/CD.',
            "## Month 1 - Observability, security, on-call\nLearn the dashboards, "
            "the secure-coding checklist and shadow an on-call rotation.",
            "Questions? Ask your onboarding buddy - no question is too small.",
        ]
    ),
}


def _chunk(
    tool: dict | None = None, text: str | None = None, finish: str | None = None
) -> ModelResponseStream:
    tool_calls = None
    if tool is not None:
        tool_calls = [
            ChatCompletionDeltaToolCall(
                id=tool.get("id"),
                type="function",
                index=0,
                function=Function(
                    name=tool.get("name"), arguments=tool.get("args", "")
                ),
            )
        ]
    return ModelResponseStream(
        choices=[
            StreamingChoices(
                index=0,
                finish_reason=finish,
                delta=Delta(content=text, tool_calls=tool_calls),
            )
        ]
    )


class ReplayClient(LiteLLMClient):
    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any):  # type: ignore[override]
        tool_done = any(
            isinstance(m, dict) and m.get("role") == "tool" for m in messages
        )

        async def stream() -> AsyncIterator[ModelResponseStream]:
            if tool_done:
                yield _chunk(text="Document written.", finish="stop")
                return
            yield _chunk(
                tool={"id": "call_replay", "name": "write_document", "args": ""}
            )
            raw = json.dumps(DOCUMENT)
            for i in range(0, len(raw), 12):
                await asyncio.sleep(CHUNK_DELAY_S)
                yield _chunk(tool={"args": raw[i : i + 12]})
            yield _chunk(finish="tool_calls")

        return stream()


def replay_model() -> LiteLlm:
    return LiteLlm(model="openai/replay", llm_client=ReplayClient())
