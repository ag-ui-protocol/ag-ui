"""AG-UI documentation assistant with a code-writing agent as a tool."""

from __future__ import annotations

from pathlib import Path

from agents import Agent, Runner
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_openai_agents import AGUITranslator
from .constants import DEFAULT_MODEL

DOCS = Path(__file__).resolve().parents[2].joinpath("README.md").read_text(encoding="utf-8")

# Documentation specialist: knows ag-ui-openai-agents docs
code_agent_instructions = f"""You are the technical specialist for the AG-UI
integration with the OpenAI Agents SDK. The documentation below is your source
of truth. Help developers understand and implement the integration: the
AGUITranslator API, AG-UI request translation, SDK streaming, FastAPI/SSE
endpoints, tools, client tools, context, state, lifecycle events, errors, and
testing.

Answer only the user's question. Retrieve and explain only the relevant parts
of the documentation; do not add a broad tutorial, related features, or extra
options unless the user asks. Be concise and practical. For code requests,
provide only the smallest complete, production-readable Python snippet needed
for the request, followed by a short explanation. Use documented APIs only. Do
not invent behavior or configuration. If the documentation does not establish
an answer, say so briefly instead of guessing.

<documentation>
{DOCS}
</documentation>
"""

docs_agent = Agent(
    name="AG-UI Documentation Specialist",
    model=DEFAULT_MODEL,
    instructions=code_agent_instructions
)

# Main Copilot: handles normal conversation and delegates documentation work.
copilot_instructions = """You are the developer-facing Copilot for an AG-UI
application. Answer only what the user asks. Be clear, practical, and concise;
do not add a tutorial, unrelated details, alternatives, or follow-up work
unless requested. Handle ordinary conversation directly.

For any question or request about AG-UI, the OpenAI Agents SDK, translator
APIs, FastAPI endpoints, streaming, tools, client tools, state, lifecycle
events, errors, tests, or Python implementation, call ask_ag_ui_docs before
answering. Treat the specialist as the source of truth for integration details.
Use only the part of its result that answers the user's question. Do not invent
integration-specific behavior or claim details the specialist did not provide.
For code requests, make sure the specialist is called."""

copilot_agent = Agent(
        name="AG-UI Docs Copilot",
        model=DEFAULT_MODEL,
        instructions=copilot_instructions,
        tools=[
            docs_agent.as_tool(
                tool_name="ask_ag_ui_docs",
                tool_description=(
                    "Provide authoritative AG-UI and OpenAI Agents SDK guidance, "
                    "including documented Python integration snippets."
                ),
            )
        ],
)

# AGUI Translator Integration
app = FastAPI(title="AG-UI Docs Copilot")
translator = AGUITranslator()

@app.post("/")
async def run_ag_ui_docs_copilot(
    body: RunAgentInput, request: Request
) -> StreamingResponse:
    """Translate one AG-UI request into an SDK run and stream it back."""
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def stream():
        # AGUI input -> OpenAI SDK
        translated_input = translator.to_sdk(body)

        # normal OpenAI SDK streaming run
        result = Runner.run_streamed(
            copilot_agent,
            input=translated_input.messages,
            context=translated_input.context,
        )

        # OpenAI SDK -> AGUI events
        async for event in translator.to_agui(result, body):
            yield encoder.encode(event)

    return StreamingResponse(stream(), media_type=encoder.get_content_type())
