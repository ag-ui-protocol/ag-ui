"""Image parts on the user message are forwarded as blob attachments."""

from typing import Any

from ag_ui_copilot_sdk import CopilotAgent

from .base import define_agent


def create_agentic_chat_multimodal_agent(client: Any) -> CopilotAgent:
    return define_agent(
        client,
        name="agentic_chat_multimodal",
        instructions=(
            "You are a helpful assistant that can analyze images, documents, and other media. "
            "When a user shares an image, describe what you see in detail. "
            "When a user shares a document, summarize its contents."
        ),
    )
