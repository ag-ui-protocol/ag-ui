"""Predictive State Updates feature.

This example demonstrates how to use predictive state updates with the ADK middleware.
Predictive state updates allow the UI to show state changes in real-time as tool
arguments are being streamed, providing a smooth document editing experience.

Key concepts:
1. PredictStateMapping: Configuration that tells the UI which tool arguments map to state keys
2. When a tool is called that matches the mapping, a PredictState CustomEvent is emitted
3. The UI uses this metadata to update state as tool arguments stream in
4. The middleware emits a write_document tool call after write_document_local completes,
   which triggers the frontend's write_document action to show a confirmation dialog
   (controlled by emit_confirm_tool=True, which is the default)

Note: We use write_document_local as the backend tool name to avoid conflicting with
the frontend's write_document action that handles the confirmation UI.

Streaming Function Call Arguments
---------------------------------
When Vertex AI credentials are available, this demo uses Gemini 3 Pro Preview with
``stream_function_call_arguments=True``.  TOOL_CALL_ARGS events then arrive
incrementally as the model generates function arguments, giving real-time UI updates.

Prerequisites for streaming:
1. Vertex AI credentials (GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC)
2. Environment variables:
   - GOOGLE_GENAI_USE_VERTEXAI=TRUE
   - GOOGLE_CLOUD_PROJECT=<your-project-id>
   - GOOGLE_CLOUD_LOCATION=global  (required for Gemini 3 models)
3. ADK version with stream_function_call_arguments support

Fallback:
- Without Vertex AI credentials falls back to Gemini 2.5 Flash (single TOOL_CALL_ARGS).

ADK workarounds (google-adk 1.23.0)
------------------------------------
Two ADK bugs prevent streaming function call args from working out of the box:

1. **Aggregator first-chunk bug** – ``StreamingResponseAggregator._process_function_call_part``
   treats the first streaming chunk (which carries the function name and
   ``will_continue=True`` but no ``partial_args``) as a *non-streaming* call and
   appends it to the parts sequence with empty args.  Subsequent chunks that carry
   ``partial_args`` accumulate into ``_current_fc_args`` but are never flushed
   because ``_current_fc_name`` was never set.  We monkey-patch the method to
   recognise ``will_continue`` on the first chunk and route it to the streaming path.

2. **Thought-signature loss** – Gemini 3 requires a ``thought_signature`` on
   ``function_call`` Parts in conversation history.  The aggregator captures it but
   ADK may drop it when reconstructing session history.  A ``before_model_callback``
   re-injects the real signature (or the ``skip_thought_signature_validator``
   sentinel) before each LLM call.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional, Tuple

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, PredictStateMapping, AGUIToolset

from google.adk.agents import LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_request import LlmRequest
from google.adk.tools import ToolContext
from google.genai import types

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Workaround 1 – Monkey-patch StreamingResponseAggregator
# ---------------------------------------------------------------------------
# Upstream bug: https://github.com/google/adk-python/issues/4311
# Remove this workaround if/when the upstream fix is released.
#
# The original _process_function_call_part dispatches on whether partial_args
# is present.  The FIRST streaming chunk carries the function name and
# will_continue=True but *no* partial_args, so it falls into the non-streaming
# branch and gets appended with empty args.  The fix: also check will_continue
# to decide whether this is the start of a streaming function call.

def _apply_aggregator_patch() -> None:
    """Monkey-patch StreamingResponseAggregator to handle streaming FC first chunk."""
    try:
        from google.adk.utils.streaming_utils import StreamingResponseAggregator
    except ImportError:
        logger.warning("Could not import StreamingResponseAggregator; skipping patch")
        return

    _original = StreamingResponseAggregator._process_function_call_part

    def _patched_process_function_call_part(self: Any, part: types.Part) -> None:
        fc = part.function_call

        has_partial_args = hasattr(fc, "partial_args") and fc.partial_args
        will_continue = getattr(fc, "will_continue", None)

        # Streaming first chunk: has name + will_continue but no partial_args yet.
        # Route it to the streaming path so _current_fc_name is set properly.
        # We must set partial_args to [] to avoid TypeError in _process_streaming_function_call
        # since partial_args may be None (attribute exists but value is None).
        if not has_partial_args and will_continue and fc.name:
            # Save thought_signature from the part (same as original code)
            if getattr(part, "thought_signature", None) and not self._current_thought_signature:
                self._current_thought_signature = part.thought_signature
            # Ensure partial_args is iterable before calling _process_streaming_function_call
            if getattr(fc, "partial_args", None) is None:
                fc.partial_args = []
            self._process_streaming_function_call(fc)
            return

        # End-of-stream marker: no partial_args, no name, will_continue is None/False.
        # If we have accumulated streaming state, flush it.
        if (
            not has_partial_args
            and not fc.name
            and not will_continue
            and self._current_fc_name
        ):
            self._flush_text_buffer_to_sequence()
            self._flush_function_call_to_sequence()
            return

        # Default: delegate to original implementation
        _original(self, part)

    StreamingResponseAggregator._process_function_call_part = _patched_process_function_call_part
    logger.info("Applied StreamingResponseAggregator monkey-patch for streaming FC first-chunk bug")


# ---------------------------------------------------------------------------
# Workaround 2 – Thought-signature repair callback
# ---------------------------------------------------------------------------
# Related to https://github.com/google/adk-python/issues/4311
# Remove this workaround if/when the upstream fix is released.

_SKIP_SENTINEL = b"skip_thought_signature_validator"


def _repair_thought_signatures(
    callback_context: CallbackContext,
    llm_request: LlmRequest,
) -> None:
    """Ensure every function_call Part has a thought_signature before the LLM call.

    Strategy:
    1. Harvest real signatures already present in contents or session events.
    2. Inject cached real signature or skip sentinel for any missing ones.
    """
    session_id = getattr(callback_context.session, "id", "unknown")

    # Collect real signatures from contents and session events
    sig_cache: Dict[str, bytes] = {}

    def _harvest(parts: list) -> None:
        for part in parts:
            fc = getattr(part, "function_call", None)
            if not fc:
                continue
            sig = getattr(part, "thought_signature", None)
            if sig and sig != _SKIP_SENTINEL:
                fc_id = getattr(fc, "id", None)
                fc_name = getattr(fc, "name", None)
                key = f"{session_id}:{fc_id or fc_name}"
                sig_cache[key] = sig

    for content in llm_request.contents:
        _harvest(getattr(content, "parts", None) or [])

    if hasattr(callback_context.session, "events"):
        for event in callback_context.session.events:
            if hasattr(event, "content") and event.content:
                _harvest(getattr(event.content, "parts", None) or [])

    # Inject missing signatures
    repaired = 0
    for content in llm_request.contents:
        for part in getattr(content, "parts", None) or []:
            fc = getattr(part, "function_call", None)
            if not fc:
                continue
            if getattr(part, "thought_signature", None):
                continue

            fc_id = getattr(fc, "id", None)
            fc_name = getattr(fc, "name", None)
            key = f"{session_id}:{fc_id or fc_name}"
            cached = sig_cache.get(key)
            part.thought_signature = cached if cached else _SKIP_SENTINEL
            repaired += 1

    if repaired:
        logger.info("Repaired %d function_call part(s) with missing thought_signature", repaired)

    return None  # continue to LLM


# ---------------------------------------------------------------------------
# Capability detection
# ---------------------------------------------------------------------------

def _has_vertex_ai_credentials() -> bool:
    """Check if Vertex AI credentials are available."""
    if os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "").upper() != "TRUE":
        return False
    if not os.getenv("GOOGLE_CLOUD_PROJECT"):
        return False
    try:
        from google.auth import default
        credentials, project = default()
        return credentials is not None
    except Exception:
        return False


def _has_streaming_function_call_support() -> bool:
    """Check if the google-genai SDK exposes stream_function_call_arguments."""
    try:
        return (
            hasattr(types, "FunctionCallingConfig")
            and hasattr(types.FunctionCallingConfig, "model_fields")
            and "stream_function_call_arguments" in types.FunctionCallingConfig.model_fields
        )
    except Exception:
        return False


def _get_model_config() -> Tuple[str, bool]:
    """Determine model and streaming capability.

    Returns:
        Tuple of (model_name, can_stream_function_args)
    """
    can_stream = _has_vertex_ai_credentials() and _has_streaming_function_call_support()
    if can_stream:
        return ("gemini-3-pro-preview", True)
    else:
        return ("gemini-2.5-flash", False)


def _get_generate_content_config(can_stream: bool) -> Optional[types.GenerateContentConfig]:
    """Create GenerateContentConfig with streaming function call args if supported."""
    if not can_stream:
        return None
    try:
        return types.GenerateContentConfig(
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    stream_function_call_arguments=True
                )
            )
        )
    except Exception as e:
        logger.warning("Failed to create streaming config: %s", e)
        return None


# ---------------------------------------------------------------------------
# Tool and agent callbacks
# ---------------------------------------------------------------------------

def write_document_local(
    tool_context: ToolContext,
    document: str
) -> Dict[str, str]:
    """
    Write a document. Use markdown formatting to format the document.
    It's good to format the document extensively so it's easy to read.
    You can use all kinds of markdown.
    However, do not use italic or strike-through formatting, it's reserved for another purpose.
    You MUST write the full document, even when changing only a few words.
    When making edits to the document, try to make them minimal - do not change every word.
    Keep stories SHORT!

    Args:
        document: The document content to write in markdown format

    Returns:
        Dict indicating success status and message
    """
    try:
        tool_context.state["document"] = document
        return {"status": "success", "message": "Document written successfully"}
    except Exception as e:
        return {"status": "error", "message": f"Error writing document: {str(e)}"}


def on_before_agent(callback_context: CallbackContext):
    """Initialize document state if it doesn't exist."""
    if "document" not in callback_context.state:
        callback_context.state["document"] = None
    return None


# ---------------------------------------------------------------------------
# Module-level configuration
# ---------------------------------------------------------------------------

_model_name, _can_stream_args = _get_model_config()
_generate_config = _get_generate_content_config(_can_stream_args)

if _can_stream_args:
    # Apply ADK monkey-patches only when streaming is active
    _apply_aggregator_patch()
    logger.info(
        "Predictive State Demo: Using %s with Vertex AI "
        "(streaming function call arguments ENABLED)", _model_name
    )
else:
    logger.info(
        "Predictive State Demo: Using %s "
        "(streaming function call arguments DISABLED - "
        "missing Vertex AI credentials or ADK support)", _model_name
    )

# Build callback list
_before_model_callbacks = []
if _can_stream_args:
    _before_model_callbacks.append(_repair_thought_signatures)

predictive_state_updates_agent = LlmAgent(
    name="DocumentAgent",
    model=_model_name,
    instruction="""
    You are a helpful assistant for writing documents.
    To write the document, you MUST use the write_document_local tool.
    You MUST write the full document, even when changing only a few words.
    When you wrote the document, DO NOT repeat it as a message.
    Just briefly summarize the changes you made. 2 sentences max.

    IMPORTANT RULES:
    1. Always use the write_document_local tool for any document writing or editing requests
    2. Write complete documents, not fragments
    3. Use markdown formatting for better readability
    4. Keep stories SHORT and engaging
    5. After using the tool, provide a brief summary of what you created or changed
    6. Do not use italic or strike-through formatting

    Examples of when to use the tool:
    - "Write a story about..." -> Use tool with complete story in markdown
    - "Edit the document to..." -> Use tool with the full edited document
    - "Add a paragraph about..." -> Use tool with the complete updated document

    Always provide complete, well-formatted documents that users can read and use.
    """,
    tools=[
        AGUIToolset(),
        write_document_local
    ],
    before_agent_callback=on_before_agent,
    before_model_callback=_before_model_callbacks if _before_model_callbacks else None,
    generate_content_config=_generate_config,
)

# Create ADK middleware agent instance with predictive state configuration
adk_predictive_state_agent = ADKAgent(
    adk_agent=predictive_state_updates_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
    predict_state=[
        PredictStateMapping(
            state_key="document",
            tool="write_document_local",
            tool_argument="document",
        )
    ],
    streaming_function_call_arguments=_can_stream_args,
)

# Create FastAPI app
app = FastAPI(title="ADK Middleware Predictive State Updates")

# Add the ADK endpoint
add_adk_fastapi_endpoint(app, adk_predictive_state_agent, path="/")
