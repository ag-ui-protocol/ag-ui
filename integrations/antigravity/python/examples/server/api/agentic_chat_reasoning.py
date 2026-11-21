"""Agentic chat with reasoning: the model's thinking streams to the chat.

The harness asks Gemini for its thought summaries (`includeThoughts`) on every
call. They arrive on the harness' steps as `thinking_delta`, which the adapter
translates to REASONING_START / REASONING_MESSAGE_* / REASONING_END, so the
chat shows the thinking before the answer. To think harder, pass
`endpoint=GeminiAPIEndpoint(options=GeminiModelOptions(thinking_level=...))`;
only models that accept a thinking level (Gemini 3 and later) take one.

The page's model dropdown writes `state.model`; Antigravity runs on Gemini
only, so this agent ignores it. The page's `change_background` frontend tool
reaches the model like any other client tool.
"""

from __future__ import annotations

from ._common import build, chat_only_capabilities

agent = build(
    capabilities=chat_only_capabilities(),
    system_instructions=(
        "You are a helpful assistant. Think the question through before you "
        "answer, then give a clear, well-structured answer. Do not read or "
        "write files unless the user explicitly asks."
    ),
)
