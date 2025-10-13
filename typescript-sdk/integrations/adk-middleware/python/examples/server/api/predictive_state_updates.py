"""Predictive State Updates feature."""

from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import json
import uuid
from typing import Dict, List, Any, Optional
from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

from google.adk.agents import LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.sessions import InMemorySessionService, Session
from google.adk.runners import Runner
from google.adk.events import Event, EventActions
from google.adk.tools import FunctionTool, ToolContext
from google.genai.types import Content, Part, FunctionDeclaration
from google.adk.models import LlmResponse, LlmRequest
from google.genai import types


def write_document(
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
        # Update the session state with the new document
        tool_context.state["document"] = document

        return {"status": "success", "message": "Document written successfully"}

    except Exception as e:
        return {"status": "error", "message": f"Error writing document: {str(e)}"}


def on_before_agent(callback_context: CallbackContext):
    """
    Initialize document state if it doesn't exist.
    """
    if "document" not in callback_context.state:
        # Initialize with empty document
        callback_context.state["document"] = None

    return None


def before_model_modifier(
    callback_context: CallbackContext, llm_request: LlmRequest
) -> Optional[LlmResponse]:
    """
    Modifies the LLM request to include the current document state.
    This enables predictive state updates by providing context about the current document.
    """
    agent_name = callback_context.agent_name
    if agent_name == "DocumentAgent":
        current_document = "No document yet"
        if "document" in callback_context.state and callback_context.state["document"] is not None:
            try:
                current_document = callback_context.state["document"]
            except Exception as e:
                current_document = f"Error retrieving document: {str(e)}"

        # Modify the system instruction to include current document state
        original_instruction = llm_request.config.system_instruction or types.Content(role="system", parts=[])
        prefix = f"""You are a helpful assistant for writing documents.
        To write the document, you MUST use the write_document tool.
        You MUST write the full document, even when changing only a few words.
        When you wrote the document, DO NOT repeat it as a message.
        Just briefly summarize the changes you made. 2 sentences max.
        This is the current state of the document: ----
        {current_document}
        -----"""

        # Ensure system_instruction is Content and parts list exists
        if not isinstance(original_instruction, types.Content):
            original_instruction = types.Content(role="system", parts=[types.Part(text=str(original_instruction))])
        if not original_instruction.parts:
            original_instruction.parts.append(types.Part(text=""))

        # Modify the text of the first part
        modified_text = prefix + (original_instruction.parts[0].text or "")
        original_instruction.parts[0].text = modified_text
        llm_request.config.system_instruction = original_instruction

    return None


# Create the predictive state updates agent
predictive_state_updates_agent = LlmAgent(
    name="DocumentAgent",
    model="gemini-2.5-pro",
    instruction="""
    You are a helpful assistant for writing documents.
    To write the document, you MUST use the write_document tool.
    You MUST write the full document, even when changing only a few words.
    When you wrote the document, DO NOT repeat it as a message.
    Just briefly summarize the changes you made. 2 sentences max.

    IMPORTANT RULES:
    1. Always use the write_document tool for any document writing or editing requests
    2. Write complete documents, not fragments
    3. Use markdown formatting for better readability
    4. Keep stories SHORT and engaging
    5. After using the tool, provide a brief summary of what you created or changed
    6. Do not use italic or strike-through formatting

    Examples of when to use the tool:
    - "Write a story about..." → Use tool with complete story in markdown
    - "Edit the document to..." → Use tool with the full edited document
    - "Add a paragraph about..." → Use tool with the complete updated document

    Always provide complete, well-formatted documents that users can read and use.
    """,
    tools=[write_document],
    before_agent_callback=on_before_agent,
    before_model_callback=before_model_modifier
)

# Create ADK middleware agent instance
adk_predictive_state_agent = ADKAgent(
    adk_agent=predictive_state_updates_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True
)

# Create FastAPI app
app = FastAPI(title="ADK Middleware Predictive State Updates")

# Add the ADK endpoint
add_adk_fastapi_endpoint(app, adk_predictive_state_agent, path="/")
