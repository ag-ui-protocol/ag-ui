"""Model wiring shared by the opt-in live tests.

The live tests run on Antigravity's native Gemini path and need
``GEMINI_API_KEY``. ``GOOGLE_GEMINI_BASE_URL`` sends the same Gemini requests
to another Gemini-compatible server, such as a gateway, instead of Google's.
"""

from __future__ import annotations

import os

import pytest

from google.antigravity.models import DEFAULT_MODEL

MODEL = os.environ.get("ANTIGRAVITY_TEST_MODEL", DEFAULT_MODEL)

requires_gemini = pytest.mark.skipif(
    not os.environ.get("GEMINI_API_KEY"),
    reason="GEMINI_API_KEY is required for live tests",
)


def endpoint():
    """The SDK endpoint for a custom Gemini base URL, or None for Google's."""
    base_url = os.environ.get("GOOGLE_GEMINI_BASE_URL")
    if not base_url:
        return None
    from google.antigravity import types

    return types.GeminiAPIEndpoint(
        base_url=base_url, api_key=os.environ["GEMINI_API_KEY"]
    )


def agent_kwargs() -> dict:
    """Model arguments for ``AntigravityAgent``."""
    kwargs = {"model": MODEL, "api_key": os.environ["GEMINI_API_KEY"]}
    custom = endpoint()
    if custom is not None:
        kwargs["endpoint"] = custom
    return kwargs


def config_kwargs() -> dict:
    """Model arguments for the SDK's ``LocalAgentConfig``."""
    custom = endpoint()
    if custom is None:
        return {"model": MODEL, "api_key": os.environ["GEMINI_API_KEY"]}
    from google.antigravity import types
    from google.antigravity.models import DEFAULT_IMAGE_GENERATION_MODEL

    return {
        "models": [
            types.ModelTarget(
                name=MODEL, types=[types.ModelType.TEXT], endpoint=custom
            ),
            types.ModelTarget(
                name=DEFAULT_IMAGE_GENERATION_MODEL,
                types=[types.ModelType.IMAGE],
                endpoint=custom,
            ),
        ]
    }
