"""``write_document`` is a FRONTEND tool; its ``document`` argument streams into
``state.document`` while the model writes it, and the browser's confirm dialog
resolves the suspended call on the next run."""

from typing import Any

from ag_ui_copilot_sdk import CopilotAgent

from .base import define_agent

INSTRUCTIONS = """You are a helpful assistant for writing documents.

To write or edit the document, you MUST use the `write_document` tool.
You MUST pass the full updated document, even when changing only a few words.
When making edits, keep them minimal: do not rewrite every word.
Format the document with markdown, but never use italic or strike-through
formatting, which is reserved for showing the user a diff.
Keep stories SHORT.

After calling the tool, do NOT repeat the document as a message. Just briefly
summarize the changes you made, 2 sentences max."""


def create_predictive_state_updates_agent(client: Any) -> CopilotAgent:
    return define_agent(
        client,
        name="predictive_state_updates",
        instructions=INSTRUCTIONS,
        predict_state=[
            {"state_key": "document", "tool": "write_document", "tool_argument": "document"}
        ],
    )
