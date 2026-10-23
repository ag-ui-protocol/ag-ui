"""Agentic chat with attachments: the user can send images and documents.

The page enables CopilotChat's attachments, so a user message arrives as text
plus image or document parts whose bytes travel inline. The adapter forwards
those to Gemini as media alongside the text, in order; anything it cannot
forward (a remote URL, an unsupported type) becomes a one-line note in the
prompt instead, so the model says it could not see the file.

The page also registers the `change_background` frontend tool, which reaches
the model like any other client tool.
"""

from __future__ import annotations

from ._common import build, chat_only_capabilities

agent = build(
    capabilities=chat_only_capabilities(),
    system_instructions=(
        "You are a helpful, concise assistant that can see images and read "
        "documents the user attaches. When a message has an attachment, "
        "describe or analyse it as asked. If a note says an attachment was "
        "not forwarded, tell the user you could not see it. Do not read or "
        "write files unless the user explicitly asks."
    ),
)
