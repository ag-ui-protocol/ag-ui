"""Shared constants for the example agents.

These examples target **native OpenAI** as the model provider — the
translators are provider-agnostic (they key windows by wire id / ``call_id``,
never assume a specific vendor), but the reference examples exercise the
straightforward path: real ids, orderly ``output_item.done`` events, no
``FAKE_RESPONSES_ID`` placeholder juggling. Point ``DEFAULT_MODEL`` at any
Responses-API model your ``OPENAI_API_KEY`` has access to.
"""

from __future__ import annotations

import os

DEFAULT_MODEL = os.getenv("OPENAI_DEFAULT_MODEL", "gpt-4.1-mini")
