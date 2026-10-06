"""Demo server exposing one Antigravity agent per dojo feature.

Against Gemini (the SDK's native path):

    export GEMINI_API_KEY=...
    uv run dev

Against a Gemini-compatible server such as aimock (the harness insists on a
key, but aimock ignores its value):

    export GOOGLE_GEMINI_BASE_URL=http://localhost:4010
    export GEMINI_API_KEY=unused
    uv run dev"""

from __future__ import annotations

import os

import uvicorn
from ag_ui_antigravity import create_antigravity_app

from .api import (
    a2ui_advanced,
    a2ui_dynamic_schema,
    a2ui_fixed_schema,
    a2ui_recovery,
    agentic_chat,
    agentic_chat_multimodal,
    agentic_chat_reasoning,
    agentic_generative_ui,
    backend_tool_rendering,
    human_in_the_loop,
    interrupt,
    shared_state,
    subgraphs,
    tool_based_generative_ui,
)
from .api._common import WORKSPACE

# Keys must match the dojo feature ids in apps/dojo/src/menu.ts.
AGENTS = {
    "agentic_chat": agentic_chat.agent,
    "human_in_the_loop": human_in_the_loop.agent,
    "tool_based_generative_ui": tool_based_generative_ui.agent,
    "backend_tool_rendering": backend_tool_rendering.agent,
    "shared_state": shared_state.agent,
    "agentic_chat_multimodal": agentic_chat_multimodal.agent,
    "agentic_chat_reasoning": agentic_chat_reasoning.agent,
    "agentic_generative_ui": agentic_generative_ui.agent,
    "a2ui_fixed_schema": a2ui_fixed_schema.agent,
    "a2ui_dynamic_schema": a2ui_dynamic_schema.agent,
    "a2ui_advanced": a2ui_advanced.agent,
    "a2ui_recovery": a2ui_recovery.agent,
    "interrupt": interrupt.agent,
    "subgraphs": subgraphs.agent,
}

app = create_antigravity_app(AGENTS)


def main() -> None:
    """Starts the demo server."""
    if not os.getenv("GEMINI_API_KEY"):
        print("⚠️  GEMINI_API_KEY is not set; every model call will fail.")
        print("   Gemini:  export GEMINI_API_KEY=...")
        print("   aimock:  export GOOGLE_GEMINI_BASE_URL=http://localhost:4010 GEMINI_API_KEY=unused")
        print()

    port = int(os.getenv("PORT", "8027"))
    print("Starting Antigravity demo server...")
    print(f"  workspace: {WORKSPACE}")
    for name in AGENTS:
        print(f"  • {name}: http://localhost:{port}/{name}")
    # Pass the app object rather than an import string: the string form only
    # resolves when the process happens to be started from this directory.
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

__all__ = ["app", "main"]
