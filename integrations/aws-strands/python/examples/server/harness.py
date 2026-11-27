"""AG-UI Dojo server for the Strands harness.

The same demos as the AWS Strands server beside this one, each served by a
Strands harness instead of a plain agent. A demo here is the plain demo's own
model, prompt, tools and AG-UI config handed to ``StrandsHarnessAgent``, so
what differs between the two servers is only the agent underneath: a harness
has a context manager that rewrites the conversation, injectors that write
into the latest user turn, background tasks, and its own approval gate.

One demo is the harness's own: ``/tool-approval`` puts a tool behind
``interventions="ask"``, the harness's gate.

    poetry install
    poetry run dev-harness

Needs ``strands-harness``, which this examples project depends on and the
adapter itself does not.
"""

import os
import tempfile
from contextlib import asynccontextmanager
from importlib import import_module

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from strands import tool

# The plain server's module: it loads examples/.env and quietens OpenTelemetry
# before any demo is imported.
import server as plain_server  # noqa: F401
from ag_ui_strands import StrandsHarnessAgent, create_strands_app

from .model_factory import create_model
from .settings import allow_credentials, cors_origins, mount_name, port_from_env

# The plain demos a harness serves as they are. Left out: the demos about a
# model feature (reasoning, citations, multimodal input) and about an
# orchestrator (multi-agent), neither of which is the harness's to change.
HARNESS_DEMO_PATHS = (
    "/agentic-chat",
    "/backend-tool-rendering",
    "/agentic-generative-ui",
    "/shared-state",
    "/human-in-the-loop",
    "/interrupt",
    "/predictive-state-updates",
    "/tool-based-generative-ui",
)
TOOL_APPROVAL_PATH = "/tool-approval"

# A harness keeps its files under ./.agent in the working directory. The demos
# keep nothing, so that goes somewhere that is thrown away.
os.chdir(tempfile.mkdtemp(prefix="strands-harness-dojo-"))


def harness_options(model, instructions, tools, **overrides) -> dict:
    """``create_harness`` options for a dojo demo.

    Everything the harness assembles by default stays on except what would act
    on this machine or keep data between visitors: its shell and file tools,
    its skills, and its memory, which is one store for every thread.
    """
    return {
        "model": model,
        # Appended to the harness's own contract, which is how a harness is
        # given its role.
        "instructions": instructions,
        "tools": tools,
        "builtin_tools": [],
        "skills": False,
        "memory": False,
        "callback_handler": None,
        **overrides,
    }


def as_harness(path: str) -> StrandsHarnessAgent:
    """The plain demo at ``path``, served by a harness."""
    demo = import_module(f"server.api.{mount_name(path)}")
    template = demo.strands_agent
    plain = getattr(demo, "agui_agent", None) or demo.agent
    return StrandsHarnessAgent(
        name=plain.name,
        description=plain.description,
        harness=harness_options(
            template.model,
            template.system_prompt,
            list(template.tool_registry.registry.values()),
        ),
        config=plain.config,
    )


@tool
def record_expense(amount: float, description: str) -> dict:
    """Record an expense in the ledger.

    Args:
        amount: The amount in US dollars.
        description: A short description of the expense.
    """
    return {
        "expenseId": f"EXP-{round(amount * 100)}",
        "amount": amount,
        "description": description,
        "status": "recorded",
    }


tool_approval_agent = StrandsHarnessAgent(
    name="tool_approval",
    description="A Strands harness whose approval gate asks before a tool runs",
    harness=harness_options(
        create_model(),
        """You are an expense assistant. Whenever the user asks you to record, log, or file an expense, you MUST call the `record_expense` tool with the `amount` in US dollars and a short `description`.

The tool asks the user to approve the call before it runs. Do not ask for confirmation yourself. After the tool returns, confirm the recorded expense id in one short sentence, or, if the call was not approved, say that the expense was not recorded.""",
        [record_expense],
        # The harness's gate: every tool call pauses the run on a `tool_call`
        # approval interrupt, answered with `{"approved": bool}`.
        interventions="ask",
    ),
)

agents = {path: as_harness(path) for path in HARNESS_DEMO_PATHS}
agents[TOOL_APPROVAL_PATH] = tool_approval_agent


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    # A harness holds work that outlives a run. See StrandsHarnessAgent.shutdown.
    for agent in agents.values():
        await agent.shutdown()


app = FastAPI(title="AWS Strands harness - AG-UI Dojo", lifespan=lifespan)
_origins = cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=allow_credentials(_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)
for _path, _agent in agents.items():
    app.mount(_path, create_strands_app(_agent, "/", origins=_origins), mount_name(_path))


@app.get("/")
def root():
    return {
        "message": "AWS Strands harness - AG-UI Dojo",
        "endpoints": {mount_name(path): path for path in agents},
    }


def main():
    """Start the server."""
    uvicorn.run(app, host="0.0.0.0", port=port_from_env())


__all__ = ["main", "app"]
