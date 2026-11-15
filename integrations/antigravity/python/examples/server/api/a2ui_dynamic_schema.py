"""A2UI dynamic schema: a second Gemini call designs the whole surface.

``generate_a2ui`` is an ordinary server tool, owned by the backend. Its body:

1. reads the run's context with ``experimental_get_context()`` -- among it the A2UI
   component schema the page sends for its catalog;
2. builds the sub-agent prompt with the A2UI toolkit (generation and design
   guidelines, the context, ``## Available Components``, and the composition
   guide below for the dojo's pre-made cards);
3. makes its own ``generateContent`` call, forced onto a single
   ``render_a2ui`` function;
4. validates the result and retries with the errors appended to the prompt
   (the toolkit's ``run_a2ui_generation_with_recovery``);
5. returns the ``a2ui_operations`` envelope, or the ``a2ui_recovery_exhausted``
   envelope once every attempt failed.

The adapter JSON-encodes the return value into ``TOOL_CALL_RESULT``, where the
runtime's A2UI middleware paints the surface, or shows the failure card.

Why not the runtime's injected ``render_a2ui`` tool, as the LangGraph demos use:
an injected tool arrives in ``RunAgentInput.tools`` as a frontend tool, and
Antigravity parks a frontend tool until a later run carries its result. Nothing
answers ``render_a2ui`` -- the middleware paints it from the streamed arguments
-- so the run would never finish. The dojo therefore leaves injection off for
this integration.

``render_a2ui`` declares ``components`` and ``data`` as JSON *strings*, like
ag-ui-adk's sub-agent tool: Gemini fills a property-less array-of-object schema
with ``{}``. A structured answer is accepted too.

Validation is structural only (ids, root, child references, cycles, bindings).
The page's schema lists only its custom components, so a membership check would
reject the basic Row the surfaces are built from.

The sub-agent call goes to the same endpoint as the harness
(``GOOGLE_GEMINI_BASE_URL``) and, under aimock, carries the same
``X-AIMock-Context`` header, so its fixtures can match it.

No ``from __future__ import annotations``: the SDK reads the live annotations.
"""

import asyncio
import json
import logging
import os
from typing import Any, Dict, Optional

import httpx
from ag_ui_a2ui_toolkit import (
    RENDER_A2UI_TOOL_DEF,
    build_a2ui_envelope,
    prepare_a2ui_request,
    resolve_a2ui_catalog,
    run_a2ui_generation_with_recovery,
    split_a2ui_schema_context,
)
from ag_ui_antigravity import experimental_get_context
from google.antigravity.models import DEFAULT_MODEL

from ._common import GEMINI_BASE_URL, MODEL, build, chat_only_capabilities

logger = logging.getLogger(__name__)

# The catalog the dojo's dynamic pages register (HotelCard / ProductCard /
# TeamMemberCard / Row). Used when the run carries no schema entry naming one.
CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json"
DEFAULT_SURFACE_ID = "dynamic-surface"
RENDER_TOOL_NAME = "render_a2ui"
# Initial try plus retries; the toolkit's default.
MAX_ATTEMPTS = 3

# Kept identical to the ADK and LangGraph dynamic examples, so every
# integration draws the same cards for the same prompt.
COMPOSITION_GUIDE = """
## Available Pre-made Components

You have 4 components. Use Row as the root with structural children to repeat a card per item.

### Row
Layout container. Use structural children to repeat a card template:
  {"id":"root","component":"Row","children":{"componentId":"card","path":"/items"}}

### HotelCard
Props: name, location, rating (number 0-5), pricePerNight, amenities (optional), action
Example:
  {"id":"card","component":"HotelCard","name":{"path":"name"},"location":{"path":"location"},
   "rating":{"path":"rating"},"pricePerNight":{"path":"pricePerNight"},
   "action":{"event":{"name":"book","context":{"name":{"path":"name"}}}}}

### ProductCard
Props: name, price, rating (number 0-5), description (optional), badge (optional), action
Example:
  {"id":"card","component":"ProductCard","name":{"path":"name"},"price":{"path":"price"},
   "rating":{"path":"rating"},"description":{"path":"description"},
   "action":{"event":{"name":"select","context":{"name":{"path":"name"}}}}}

### TeamMemberCard
Props: name, role, department (optional), email (optional), avatarUrl (optional), action
Example:
  {"id":"card","component":"TeamMemberCard","name":{"path":"name"},"role":{"path":"role"},
   "department":{"path":"department"},"email":{"path":"email"},
   "action":{"event":{"name":"contact","context":{"name":{"path":"name"}}}}}

## RULES
- Root is ALWAYS a Row with structural children: {"componentId":"<card-id>","path":"/items"}
- Inside templates, use RELATIVE paths (no leading slash): {"path":"name"} not {"path":"/name"}
- Always provide data in the "data" argument as {"items":[...]}
- Pick the card type that best matches the user's request
- Generate 3-4 realistic items with diverse data
"""

RENDER_A2UI_DECLARATION = {
    "name": RENDER_TOOL_NAME,
    "description": RENDER_A2UI_TOOL_DEF["function"]["description"],
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "surfaceId": {
                "type": "STRING",
                "description": "Unique surface identifier.",
            },
            "components": {
                "type": "STRING",
                "description": (
                    "The A2UI v0.9 component array as a JSON string, e.g. "
                    '\'[{"id":"root","component":"Row","children":'
                    '{"componentId":"card","path":"/items"}}]\'. '
                    "The root component must have id 'root'."
                ),
            },
            "data": {
                "type": "STRING",
                "description": (
                    "The surface data model as a JSON string, e.g. "
                    "'{\"items\":[...]}'. Use '{}' when there is none."
                ),
            },
        },
        "required": ["surfaceId", "components"],
    },
}


def _parse_json_arg(value: Any, expect: type) -> Any:
    """Parses a JSON-string argument; anything unparseable is returned as is.

    A value left as a string fails validation, so the loop retries instead of
    painting garbage. A lone component object is wrapped in a list.
    """
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return value
    if expect is list and isinstance(parsed, dict):
        return [parsed]
    return parsed


def _coerce_render_args(args: Dict[str, Any]) -> Dict[str, Any]:
    coerced = dict(args)
    if "components" in coerced:
        coerced["components"] = _parse_json_arg(coerced["components"], list)
    if "data" in coerced:
        coerced["data"] = _parse_json_arg(coerced["data"], dict)
    return coerced


def _render_once(client: httpx.Client, system_prompt: str, request: str) -> Optional[Dict[str, Any]]:
    """One forced ``render_a2ui`` call. ``None`` when the model did not call it.

    The retry is told apart from the first attempt by the error block the
    toolkit appends to ``system_prompt``; ``request`` is the user turn.
    """
    base = (GEMINI_BASE_URL or "https://generativelanguage.googleapis.com").rstrip("/")
    headers = {}
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        headers["x-goog-api-key"] = key
    context = os.environ.get("AIMOCK_CONTEXT")
    if context:
        headers["X-AIMock-Context"] = context
    body = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": request}]}],
        "tools": [{"functionDeclarations": [RENDER_A2UI_DECLARATION]}],
        "toolConfig": {
            "functionCallingConfig": {
                "mode": "ANY",
                "allowedFunctionNames": [RENDER_TOOL_NAME],
            }
        },
    }
    try:
        response = client.post(
            f"{base}/v1beta/models/{MODEL or DEFAULT_MODEL}:generateContent",
            json=body,
            headers=headers,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        # Counted as a failed attempt: the loop retries, and if every attempt
        # fails the user sees the failure card rather than a hung turn.
        logger.exception("render_a2ui call failed")
        return None
    candidates = payload.get("candidates") or [{}]
    parts = (candidates[0].get("content") or {}).get("parts") or []
    for part in parts:
        call = part.get("functionCall")
        if call and call.get("name") == RENDER_TOOL_NAME:
            return _coerce_render_args(call.get("args") or {})
    return None


def _log_attempt(record: Dict[str, Any]) -> None:
    logger.info(
        "[a2ui] attempt %s: %s %s",
        record.get("attempt"),
        "valid" if record.get("ok") else "invalid",
        record.get("errors"),
    )


def _generate(request: str, context: list) -> Dict[str, Any]:
    """The whole generate -> validate -> retry loop; blocking."""
    schema, regular = split_a2ui_schema_context(context)
    ag_ui: Dict[str, Any] = {"context": regular}
    if schema:
        ag_ui["a2ui_schema"] = schema
    state = {"ag-ui": ag_ui}
    resolved = resolve_a2ui_catalog(state)
    catalog_id = (resolved[1] if resolved else None) or CATALOG_ID

    prep = prepare_a2ui_request(
        intent="create",
        target_surface_id=None,
        changes=None,
        messages=[],
        state=state,
        guidelines={"composition_guide": COMPOSITION_GUIDE},
    )

    with httpx.Client(timeout=120.0) as client:
        result = run_a2ui_generation_with_recovery(
            base_prompt=prep["prompt"],
            invoke_subagent=lambda prompt, _attempt: _render_once(client, prompt, request),
            build_envelope=lambda generated: build_a2ui_envelope(
                args=generated,
                is_update=False,
                target_surface_id=None,
                prior=None,
                default_surface_id=DEFAULT_SURFACE_ID,
                default_catalog_id=catalog_id,
            ),
            config={"maxAttempts": MAX_ATTEMPTS},
            on_attempt=_log_attempt,
        )
    return json.loads(result["envelope"])


async def generate_a2ui(request: str) -> Dict[str, Any]:
    """Draws a rich visual A2UI surface (cards, comparisons, rosters) for a request.

    Pass the user's request verbatim. A second model designs the surface from
    the app's component catalog, so do not add layout instructions yourself.

    The JSON returned is the surface the UI has already drawn, or a failure the
    UI has already shown -- not something to repeat. Do NOT call this tool again
    for the same request. Reply with one short sentence and stop.

    Args:
      request: The user's request, verbatim.
    """
    # Read the context here, on the tool's own task: the loop below blocks, so
    # it runs on a worker thread to keep the event loop free.
    context = experimental_get_context()
    return await asyncio.to_thread(_generate, request, context)


SYSTEM_PROMPT = (
    "You are a helpful assistant that creates rich visual UI on the fly.\n"
    "- When the user asks for visual content (comparisons, lists, cards, "
    "rosters), call generate_a2ui exactly once, passing their request "
    "verbatim.\n"
    "- The tool draws the UI itself. Afterwards, do not repeat the data: reply "
    "with one short sentence confirming what was drawn, and stop.\n"
    "- If the tool reports that it could not generate the UI, say so in one "
    "sentence; do not call it again."
)

agent = build(
    capabilities=chat_only_capabilities(),
    tools=[generate_a2ui],
    system_instructions=SYSTEM_PROMPT,
)
