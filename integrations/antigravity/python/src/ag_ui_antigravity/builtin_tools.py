"""Experimental read-only tools an agent can opt into.

Antigravity fixes an agent's instructions when the harness session starts, so
the per-run parts of ``RunAgentInput`` -- the client's context and shared state
-- cannot be folded into the prompt the way other integrations do. These tools
let the model pull them instead. They run silently: the client sees no tool
call for them, just as it sees none for a prompt that other frameworks rebuild.

Neither is on by default. ``AntigravityAgent(experimental_app_context=True)``
adds ``get_app_context`` and ``experimental_app_state=True`` adds
``get_shared_state``.
"""

from __future__ import annotations

from typing import Any, Dict, List

from .ui_bridge import experimental_get_context, experimental_get_state

def get_app_context() -> List[Dict[str, str]]:
    """Returns what the application tells you about the user's current situation.

    Each entry has a description and a value, such as the user's name, their
    preferences, or what is on screen. Call this before answering whenever the
    answer could depend on the user, their settings, or the page they are on.
    """
    return experimental_get_context()


def get_shared_state() -> Dict[str, Any]:
    """Returns the application state you share with the user interface.

    The user can change this state in the app at any time, so call this before
    answering whenever the answer could depend on it, rather than relying on
    what it contained earlier in the conversation.
    """
    return experimental_get_state()

