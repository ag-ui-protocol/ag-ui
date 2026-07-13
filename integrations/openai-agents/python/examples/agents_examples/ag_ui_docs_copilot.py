"""AG-UI documentation assistant with two focused specialists as tools."""

from __future__ import annotations

from pathlib import Path

from agents import Agent, Runner
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_openai_agents import AGUITranslator
from .constants import DEFAULT_MODEL

# ag-ui-protocol specialist: knows the core Python SDK documentation
AG_UI_PROTOCOL_DOCS = Path(__file__).resolve().parents[5].joinpath(
    "sdks/python/README.md"
).read_text(encoding="utf-8")
AG_UI_PROTOCOL_DOCS_INSTRUCTIONS = f"""You are the technical specialist for
AG-UI Protocol's core Python SDK. The documentation below is your source of
truth. Help developers understand the ag_ui.core data models, RunAgentInput,
messages, events, event types, and ag_ui.encoder EventEncoder, including how to
create and stream protocol events.

Answer only the user's question. Retrieve and explain only the relevant parts
of the documentation; do not add a broad tutorial or unrelated integration
details. Be concise and practical. For code requests, provide only the
smallest complete, production-readable Python snippet needed for the request,
followed by a short explanation. Use documented APIs only. If the
documentation does not establish an answer, say so briefly instead of
guessing.

<documentation>
{AG_UI_PROTOCOL_DOCS}
</documentation>
"""

ag_ui_protocol_docs_agent = Agent(
    name="AG-UI Protocol Python Specialist",
    model=DEFAULT_MODEL,
    instructions=AG_UI_PROTOCOL_DOCS_INSTRUCTIONS,
)


# ag-ui-openai-agents specialist: knows the integration documentation
AG_UI_OPENAI_AGENTS_DOCS = Path(__file__).resolve().parents[2].joinpath(
    "README.md"
).read_text(encoding="utf-8")
AG_UI_OPENAI_AGENTS_DOCS_INSTRUCTIONS = f"""You are the technical specialist for
AG-UI OpenAI Agents integration. The documentation below is your source of
truth. Help developers understand and implement the integration: the
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
{AG_UI_OPENAI_AGENTS_DOCS}
</documentation>
"""

ag_ui_openai_agents_docs_agent = Agent(
    name="AG-UI OpenAI Agents Specialist",
    model=DEFAULT_MODEL,
    instructions=AG_UI_OPENAI_AGENTS_DOCS_INSTRUCTIONS,
)



# Main Copilot: handles normal conversation and delegates documentation work.
copilot_instructions = """You are the developer-facing Copilot for an AG-UI
application. Answer only what the user asks. Be clear, practical, and concise;
do not add a tutorial, unrelated details, alternatives, or follow-up work
unless requested. Handle ordinary conversation directly.

For any question or request about AG-UI, the OpenAI Agents SDK, translator
APIs, FastAPI endpoints, streaming, tools, client tools, state, lifecycle
events, errors, tests, or Python implementation, call the relevant specialist
before answering. Use ask_ag_ui_openai_agents_docs for the OpenAI Agents SDK
integration and ask_ag_ui_protocol_docs for ag_ui.core protocol types and
EventEncoder questions.
Use only the part of the specialist's result that answers the user's question.
Do not invent behavior or claim details a specialist did not provide. For code
requests, make sure the relevant specialist is called."""

copilot_agent = Agent(
        name="AG-UI Docs Copilot",
        model=DEFAULT_MODEL,
        instructions=copilot_instructions,
        tools=[
            ag_ui_protocol_docs_agent.as_tool(
                tool_name="ask_ag_ui_protocol_docs",
                tool_description=(
                    "Provide authoritative AG-UI core Python SDK guidance about "
                    "protocol types, RunAgentInput, events, and EventEncoder."
                ),
            ),
            ag_ui_openai_agents_docs_agent.as_tool(
                tool_name="ask_ag_ui_openai_agents_docs",
                tool_description=(
                    "Provide authoritative AG-UI and OpenAI Agents SDK guidance, "
                    "including documented Python integration snippets."
                ),
            ),
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
        translated_input = translator.to_openai(body)

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
