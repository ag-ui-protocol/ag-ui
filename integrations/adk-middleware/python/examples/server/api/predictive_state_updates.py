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
When Vertex AI credentials are available, this demo uses Gemini 3 Flash Preview with
``stream_function_call_arguments=True``.  TOOL_CALL_ARGS events then arrive
incrementally as the model generates function arguments, giving real-time UI updates.
Gemini 3 models are required because ``stream_function_call_arguments`` is only
supported by the Gemini 3 family.

Prerequisites for streaming:
1. Vertex AI credentials (GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC)
2. Environment variables:
   - GOOGLE_GENAI_USE_VERTEXAI=TRUE
   - GOOGLE_CLOUD_PROJECT=<your-project-id>
   - GOOGLE_CLOUD_LOCATION=global  (required for Gemini 3 models)
3. ADK version with stream_function_call_arguments support

Fallback:
- Without Vertex AI credentials falls back to Gemini 2.5 Flash (single TOOL_CALL_ARGS).

ADK workarounds for Gemini 3 (google-adk 1.23.0):

1. **Aggregator patch** – Applied explicitly in this example via
   ``apply_aggregator_patch()`` from ``ag_ui_adk.workarounds``.  This fixes
   the StreamingResponseAggregator first-chunk bug so that session history
   contains valid function call parts.  It is NOT auto-applied by the
   middleware because it conflicts with the event translator's Mode A streaming.

2. **Thought-signature repair** – Automatically injected by the middleware as a
   ``before_model_callback`` when ``streaming_function_call_arguments=True``.
"""

from __future__ import annotations

import logging
import os
from typing import Dict, Optional, Tuple

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, PredictStateMapping, AGUIToolset
from ag_ui_adk.workarounds import apply_aggregator_patch

from google.adk.agents import LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.tools import ToolContext
from google.genai import types

logger = logging.getLogger(__name__)


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
        return ("gemini-3-flash-preview", True)
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
    apply_aggregator_patch()

logger.info(
    "Predictive State Demo: Using %s (streaming function call arguments %s)",
    _model_name,
    "ENABLED" if _can_stream_args else "DISABLED",
)

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
