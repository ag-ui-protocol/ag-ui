"""Wire-level discriminator values for OpenAI Agents SDK streaming.

Single home for every "type" string the translators dispatch on. Members
are (str, Enum) (StrEnum needs Python 3.11; this package supports 3.9+),
so they compare equal to the raw wire strings. The SDK's own Literal[...]
annotations are the source of truth — see tests/test_stream_types_drift.py.
"""

from __future__ import annotations

from enum import Enum


class SDKStreamEventType(str, Enum):
    """Top-level StreamEvent.type values yielded by Runner.run_streamed."""

    RAW_RESPONSE = "raw_response_event"
    RUN_ITEM = "run_item_stream_event"
    AGENT_UPDATED = "agent_updated_stream_event"


class RawResponseEventType(str, Enum):
    """Raw Responses-API delta type values the outbound translator consumes.

    Non-semantic bookkeeping kinds (response.created / .completed,
    content_part.*, audio) are deliberately absent — they translate to
    nothing.
    """

    OUTPUT_ITEM_ADDED = "response.output_item.added"
    OUTPUT_ITEM_DONE = "response.output_item.done"
    TEXT_DELTA = "response.output_text.delta"
    TEXT_DONE = "response.output_text.done"
    REFUSAL_DELTA = "response.refusal.delta"
    FUNCTION_CALL_ARGUMENTS_DELTA = "response.function_call_arguments.delta"
    REASONING_SUMMARY_DELTA = "response.reasoning_summary_text.delta"
    REASONING_SUMMARY_PART_DONE = "response.reasoning_summary_part.done"
    REASONING_TEXT_DELTA = "response.reasoning_text.delta"
    REASONING_TEXT_DONE = "response.reasoning_text.done"


class SDKItemType(str, Enum):
    """Output-item type values carried by output_item.added / .done."""

    MESSAGE = "message"
    FUNCTION_CALL = "function_call"
    REASONING = "reasoning"


# Tools that run on OpenAI's side. We still show them as AG-UI tool calls, but
# the API doesn't stream their arguments, so at the raw level all we can emit is
# START/END. The run-item layer fills in the rest when it has it.
HOSTED_TOOL_CALL_TYPES: frozenset[str] = frozenset(
    {
        "web_search_call",
        "file_search_call",
        "code_interpreter_call",
        "image_generation_call",
        "computer_call",
        "local_shell_call",
        "shell_call",
        "apply_patch_call",
        "mcp_call",
        "custom_tool_call",
        "tool_search_call",
    }
)
