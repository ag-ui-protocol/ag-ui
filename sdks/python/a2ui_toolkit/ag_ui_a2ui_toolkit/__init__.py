"""
ag-ui-a2ui-toolkit
==================

Framework-agnostic building blocks for A2UI subagent tools. Each per-
framework adapter (LangGraph, ADK, Mastra, …) composes these helpers with its
framework-specific glue (tool decorator, runtime accessor, model binding +
invoke). Nothing in this package depends on any agent framework.
"""

from __future__ import annotations

import json
from typing import Any, Optional, TypedDict


__all__ = [
    "A2UI_OPERATIONS_KEY",
    "BASIC_CATALOG_ID",
    "RENDER_A2UI_TOOL_DEF",
    "DEFAULT_SURFACE_ID",
    "GENERATE_A2UI_TOOL_NAME",
    "GENERATE_A2UI_TOOL_DESCRIPTION",
    "GENERATE_A2UI_ARG_DESCRIPTIONS",
    "create_surface",
    "update_components",
    "update_data_model",
    "build_context_prompt",
    "find_prior_surface",
    "build_subagent_prompt",
    "assemble_ops",
    "wrap_as_operations_envelope",
    "wrap_error_envelope",
    "prepare_a2ui_request",
    "build_a2ui_envelope",
    "PriorSurface",
    "EditContext",
    "PreparedA2UIRequest",
    # Error-recovery loop (OSS-162)
    "validate_a2ui_components",
    "A2UIValidationError",
    "ValidateA2UIResult",
    "MAX_A2UI_ATTEMPTS",
    "A2UI_RECOVERY_ACTIVITY_TYPE",
    "format_validation_errors",
    "augment_prompt_with_validation_errors",
    "run_a2ui_generation_with_recovery",
]

# Error-recovery loop (OSS-162) — semantic validation + validate→retry loop,
# shared so the middleware (paint gate) and adapters (retry driver) agree.
from .validate import (  # noqa: E402
    validate_a2ui_components,
    A2UIValidationError,
    ValidateA2UIResult,
)
from .recovery import (  # noqa: E402
    MAX_A2UI_ATTEMPTS,
    A2UI_RECOVERY_ACTIVITY_TYPE,
    format_validation_errors,
    augment_prompt_with_validation_errors,
    run_a2ui_generation_with_recovery,
)


A2UI_OPERATIONS_KEY = "a2ui_operations"
"""Container key the A2UI middleware looks for in tool results."""

BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json"
"""Default catalog id used when the subagent does not specify one."""


# ---------------------------------------------------------------------------
# Op builders
# ---------------------------------------------------------------------------


def create_surface(surface_id: str, catalog_id: str) -> dict[str, Any]:
    return {
        "version": "v0.9",
        "createSurface": {"surfaceId": surface_id, "catalogId": catalog_id},
    }


def update_components(
    surface_id: str, components: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "version": "v0.9",
        "updateComponents": {"surfaceId": surface_id, "components": components},
    }


def update_data_model(
    surface_id: str, data: Any, path: str = "/"
) -> dict[str, Any]:
    return {
        "version": "v0.9",
        "updateDataModel": {"surfaceId": surface_id, "path": path, "value": data},
    }


# ---------------------------------------------------------------------------
# Inner render_a2ui tool definition
# ---------------------------------------------------------------------------

RENDER_A2UI_TOOL_DEF: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "render_a2ui",
        "description": (
            "Render a dynamic A2UI v0.9 surface. The root component must have "
            "id 'root'. Use components from the available catalog only."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "surfaceId": {
                    "type": "string",
                    "description": "Unique surface identifier.",
                },
                "components": {
                    "type": "array",
                    "description": (
                        "A2UI v0.9 component array (flat format). The root "
                        "component must have id 'root'."
                    ),
                    "items": {"type": "object"},
                },
                "data": {
                    "type": "object",
                    "description": (
                        "Optional initial data model for the surface (form "
                        "values, list items for data-bound components, etc.)."
                    ),
                },
            },
            "required": ["surfaceId", "components"],
        },
    },
}
"""JSON schema for the inner ``render_a2ui`` tool the subagent is forced to call."""


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------


def build_context_prompt(state: dict) -> str:
    """Assemble the prompt prefix from AG-UI state context entries + the A2UI
    component catalog.

    Framework integrations conventionally extract the catalog into
    ``state["ag-ui"]["a2ui_schema"]`` and forward other context entries
    (generation guidelines, design guidelines) under
    ``state["ag-ui"]["context"]``.
    """
    ag_ui = state.get("ag-ui", {}) or {}
    parts: list[str] = []

    for entry in ag_ui.get("context", []) or []:
        if isinstance(entry, dict):
            desc = entry.get("description")
            value = entry.get("value")
        else:
            desc = getattr(entry, "description", None)
            value = getattr(entry, "value", None)
        # Mirror the TS toolkit: a null/None value with a description must NOT
        # leak the literal string "None" into the subagent prompt. f-string
        # interpolation would do that — coerce to "" first.
        value_str = "" if value is None else str(value)
        if desc:
            parts.append(f"## {desc}\n{value_str}\n")
        elif value_str:
            parts.append(f"{value_str}\n")

    a2ui_schema = ag_ui.get("a2ui_schema")
    if a2ui_schema:
        parts.append(f"## Available Components\n{a2ui_schema}\n")

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Prior surface lookup (used for intent="update")
# ---------------------------------------------------------------------------


class PriorSurface(TypedDict, total=False):
    components: list[dict[str, Any]]
    data: Any
    catalogId: Optional[str]


def _message_role_and_content(msg: Any) -> tuple[Optional[str], Any]:
    """Read a message's role/type and content from either an object or a dict.

    LangChain ToolMessage instances expose ``.type``/``.role``/``.content`` as
    attributes; messages that round-tripped through JSON arrive as plain dicts.
    Either shape needs to work — the prior-surface walker must not silently skip
    dict-shaped history.
    """
    if isinstance(msg, dict):
        role = msg.get("type") or msg.get("role")
        return role, msg.get("content")
    return (
        getattr(msg, "type", None) or getattr(msg, "role", None),
        getattr(msg, "content", None),
    )


def find_prior_surface(
    messages: list[Any], surface_id: str
) -> Optional[PriorSurface]:
    """Locate the most recent rendered state for ``surface_id`` in message history.

    Walks backwards over tool messages whose content is a JSON string containing
    ``a2ui_operations`` for the given surface, accumulating the most recent
    value of each field (``components``, ``data``, ``catalogId``) across the
    walk. A late-turn message that only emits ``updateDataModel`` no longer
    blanks the components / catalogId established by an earlier turn — the
    function returns the surface's *latest known state*, not just what the most
    recent matching message happened to carry.

    Accepts both object-shaped and dict-shaped messages.

    Returns the reconstructed ``{"components": [...], "data": ..., "catalogId": ...}``
    or ``None`` if no matching surface is found anywhere in history.
    """
    # Per-message end-state is computed FORWARD because the renderer applies
    # ops in document order. The last op affecting the surface in a message
    # determines that message's contribution — including ``deleteSurface``,
    # which wipes the surface. If the NEWEST message to mention the surface
    # ends in delete, return ``None``: older create/update ops are stale and
    # would resurrect a surface the renderer no longer shows.
    components: Optional[list[dict[str, Any]]] = None
    data: Any = None
    data_seen = False
    catalog_id: Optional[str] = None
    matched = False

    for msg in reversed(messages):
        role, content = _message_role_and_content(msg)
        if role not in ("tool", "ToolMessage"):
            continue
        if not isinstance(content, str):
            continue
        try:
            parsed = json.loads(content)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        ops = parsed.get(A2UI_OPERATIONS_KEY)
        if not isinstance(ops, list):
            continue

        # Compute this message's end state for surface_id by walking ops
        # forward. ``deleteSurface`` resets the per-message accumulator;
        # subsequent create / update ops in the same message restore it.
        msg_mentions = False
        msg_deleted = False
        msg_catalog_id: Optional[str] = None
        msg_components: Optional[list[dict[str, Any]]] = None
        msg_data: Any = None
        msg_data_seen = False

        for op in ops:
            if not isinstance(op, dict):
                continue
            if "deleteSurface" in op:
                ds = op["deleteSurface"]
                if isinstance(ds, dict) and ds.get("surfaceId") == surface_id:
                    msg_mentions = True
                    msg_deleted = True
                    msg_catalog_id = None
                    msg_components = None
                    msg_data = None
                    msg_data_seen = False
                    continue
            if "createSurface" in op:
                cs = op["createSurface"]
                if isinstance(cs, dict) and cs.get("surfaceId") == surface_id:
                    msg_mentions = True
                    msg_deleted = False
                    if isinstance(cs.get("catalogId"), str):
                        msg_catalog_id = cs["catalogId"]
            if "updateComponents" in op:
                uc = op["updateComponents"]
                if isinstance(uc, dict) and uc.get("surfaceId") == surface_id:
                    msg_mentions = True
                    msg_deleted = False
                    if isinstance(uc.get("components"), list):
                        msg_components = uc["components"]
            if "updateDataModel" in op:
                ud = op["updateDataModel"]
                if isinstance(ud, dict) and ud.get("surfaceId") == surface_id:
                    msg_mentions = True
                    msg_deleted = False
                    msg_data = ud.get("value")
                    msg_data_seen = True

        if not msg_mentions:
            continue

        if not matched:
            # Newest message that mentions the surface — its end state is
            # authoritative.
            if msg_deleted:
                return None
            matched = True
            catalog_id = msg_catalog_id
            components = msg_components
            data = msg_data
            data_seen = msg_data_seen
        else:
            # Older message: fill in only the fields not yet set. A delete
            # here is overridden by the newer state already recorded.
            if msg_deleted:
                continue
            if catalog_id is None and msg_catalog_id is not None:
                catalog_id = msg_catalog_id
            if components is None and msg_components is not None:
                components = msg_components
            if not data_seen and msg_data_seen:
                data = msg_data
                data_seen = True

        # Early-exit once every field is populated — nothing older can override.
        if matched and components is not None and catalog_id is not None and data_seen:
            return {"components": components, "data": data, "catalogId": catalog_id}

    if not matched:
        return None
    return {
        "components": components or [],
        "data": data,
        "catalogId": catalog_id,
    }


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------


class EditContext(TypedDict, total=False):
    surfaceId: str
    prior: PriorSurface
    changes: Optional[str]


def build_subagent_prompt(
    *,
    context_prompt: str,
    composition_guide: Optional[str] = None,
    edit_context: Optional[EditContext] = None,
) -> str:
    """Compose the full subagent system prompt.

    Args:
        context_prompt: Output of ``build_context_prompt(state)``.
        composition_guide: Project-specific composition rules to append.
        edit_context: When set, instructs the subagent to edit a prior surface
            in place (used by ``intent="update"``).
    """
    parts: list[str] = []
    if context_prompt:
        parts.append(context_prompt)
    if composition_guide:
        parts.append(composition_guide)

    if edit_context:
        surface_id = edit_context.get("surfaceId")
        prior = edit_context.get("prior") or {}
        changes = edit_context.get("changes")
        edit_block = (
            "## Editing an existing surface\n"
            f"You are editing surface '{surface_id}'. Produce the FULL "
            f"updated components array and data model — not just a diff. "
            f"Preserve component ids that the user has not asked to change so "
            f"the renderer can reconcile them. Reuse the same catalogId.\n\n"
            f"### Previous components\n"
            f"{json.dumps(prior.get('components', []), indent=2)}\n\n"
            f"### Previous data\n"
            f"{json.dumps(prior.get('data'), indent=2)}\n"
        )
        if changes:
            edit_block += f"\n### Requested changes\n{changes}\n"
        parts.append(edit_block)

    return "\n".join(p for p in parts if p)


# ---------------------------------------------------------------------------
# Operations envelope
# ---------------------------------------------------------------------------


def assemble_ops(
    *,
    intent: str,
    surface_id: str,
    catalog_id: str,
    components: list[dict[str, Any]],
    data: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    """Produce the final A2UI v0.9 operation list for a render result.

    ``intent="create"`` emits ``[createSurface, updateComponents, updateDataModel?]``.
    Any other intent (e.g. ``"update"``) skips ``createSurface`` so the
    frontend reconciles the existing surface in place rather than erroring
    (per v0.9 spec, ``createSurface`` on an existing id is invalid).
    """
    ops: list[dict[str, Any]] = []
    if intent != "update":
        ops.append(create_surface(surface_id, catalog_id))
    ops.append(update_components(surface_id, components))
    if data:
        ops.append(update_data_model(surface_id, data))
    return ops


def wrap_as_operations_envelope(ops: list[dict[str, Any]]) -> str:
    """Wrap a list of A2UI operations as the JSON envelope the A2UI middleware
    looks for in tool results."""
    return json.dumps({A2UI_OPERATIONS_KEY: ops})


def wrap_error_envelope(message: str) -> str:
    """Wrap an error as the JSON string a subagent tool returns when it can't
    produce a surface. Keeps the error shape consistent across frameworks."""
    return json.dumps({"error": message})


# ---------------------------------------------------------------------------
# Subagent-tool defaults (shared so every framework adapter advertises the
# same planner-facing surface and behaviour)
# ---------------------------------------------------------------------------

DEFAULT_SURFACE_ID = "dynamic-surface"
"""Surface id used when the subagent omits ``surfaceId`` on a create."""

GENERATE_A2UI_TOOL_NAME = "generate_a2ui"
"""Default name the outer A2UI tool is advertised under to the main planner."""

GENERATE_A2UI_TOOL_DESCRIPTION = (
    "Generate or update a dynamic A2UI surface based on the conversation. "
    "A secondary LLM designs the UI components and data. "
    "Use intent='create' (default) when the user requests new visual content "
    "(cards, forms, lists, dashboards, comparisons, etc.). "
    "Use intent='update' with target_surface_id to modify a surface you "
    "previously rendered (e.g. 'change the second card's price', "
    "'add a Buy button', 'use red instead of blue')."
)
"""Default description shown to the main agent's planner."""

GENERATE_A2UI_ARG_DESCRIPTIONS: dict[str, str] = {
    "intent": (
        "'create' to render a new surface; 'update' to modify a surface "
        "previously rendered in this conversation. Defaults to 'create'."
    ),
    "target_surface_id": (
        "Required when intent='update'. The surface id of the prior render to modify."
    ),
    "changes": (
        "Optional natural-language description of the changes to apply when intent='update'."
    ),
}
"""Planner-facing descriptions for the outer tool's three arguments."""


# ---------------------------------------------------------------------------
# High-level orchestration
#
# These two functions hold the entire create/update decision + prompt prep +
# result-assembly logic so every framework adapter is reduced to pure glue
# (tool decorator, state access, model bind+invoke, tool-call read).
# ---------------------------------------------------------------------------


class PreparedA2UIRequest(TypedDict, total=False):
    prompt: str
    is_update: bool
    prior: Optional[PriorSurface]
    error: Optional[str]


def prepare_a2ui_request(
    *,
    intent: Optional[str],
    target_surface_id: Optional[str],
    changes: Optional[str],
    messages: list[Any],
    state: dict,
    composition_guide: Optional[str] = None,
) -> PreparedA2UIRequest:
    """Resolve the create/update decision, locate any prior surface, and build
    the subagent system prompt.

    Returns a dict with ``error`` set (and no ``prompt``) when the request is
    invalid — an ``update`` referencing a surface not found in history.
    """
    resolved_intent = intent or "create"
    is_update = resolved_intent == "update" and bool(target_surface_id)

    # is_update being True already narrows target_surface_id to non-empty str;
    # assert it explicitly so a type checker sees the same narrowing the runtime
    # condition guarantees, without resorting to a blanket type: ignore.
    if is_update:
        assert target_surface_id is not None
        prior = find_prior_surface(messages, target_surface_id)
    else:
        prior = None

    if is_update and prior is None:
        # Match TS shape: omit ``prior`` from the error branch so presence
        # checks like ``"prior" in prep`` distinguish success from failure.
        return {
            "prompt": "",
            "is_update": is_update,
            "error": (
                f"intent='update' requested target_surface_id="
                f"'{target_surface_id}' but no prior render of that surface "
                f"was found in conversation history"
            ),
        }

    prompt = build_subagent_prompt(
        context_prompt=build_context_prompt(state),
        composition_guide=composition_guide,
        edit_context=(
            {"surfaceId": target_surface_id, "prior": prior, "changes": changes}
            if prior is not None
            else None
        ),
    )

    # Omit ``error`` on success so ``"error" in prep`` is a meaningful presence
    # check (matches the TS counterpart which only returns the key on failure).
    return {"prompt": prompt, "is_update": is_update, "prior": prior}


def build_a2ui_envelope(
    *,
    args: dict[str, Any],
    is_update: bool,
    target_surface_id: Optional[str],
    prior: Optional[PriorSurface],
    default_surface_id: str = DEFAULT_SURFACE_ID,
    default_catalog_id: str = BASIC_CATALOG_ID,
) -> str:
    """Turn the subagent's structured output into the final operations envelope.

    Catalog ownership stays with the host: the subagent never picks a catalog,
    so the id comes from the prior surface (update) or the configured default
    (create) — never from the model's args.
    """
    # Treat empty-string defaults as unset (mirror the TS guard). Without this,
    # a misconfigured host passing ``""`` for default_surface_id /
    # default_catalog_id would propagate the empty string into the emitted ops
    # and surface as "Catalog not found: " / blank surface ids at render time,
    # hiding the real cause.
    safe_default_surface_id = default_surface_id or DEFAULT_SURFACE_ID
    safe_default_catalog_id = default_catalog_id or BASIC_CATALOG_ID

    # Narrow args["surfaceId"] to a non-empty STRING — the model is untrusted
    # and may return ``null``, a number, a list, or an empty string. Without
    # this, those values propagate into ``createSurface.surfaceId`` and the
    # renderer either crashes or silently mounts to an unreachable surface
    # id. Mirrors the TS narrow (``typeof === "string" && length > 0``).
    raw_arg_surface_id = args.get("surfaceId")
    arg_surface_id = (
        raw_arg_surface_id
        if isinstance(raw_arg_surface_id, str) and len(raw_arg_surface_id) > 0
        else ""
    )
    if is_update:
        surface_id = target_surface_id or safe_default_surface_id
    else:
        surface_id = arg_surface_id or safe_default_surface_id
    catalog_id = (prior or {}).get("catalogId") or safe_default_catalog_id
    # Narrow to the documented shapes — the model's args are untrusted.
    raw_components = args.get("components")
    components = raw_components if isinstance(raw_components, list) else []
    raw_data = args.get("data")
    data = raw_data if isinstance(raw_data, dict) else {}

    ops = assemble_ops(
        intent="update" if is_update else "create",
        surface_id=surface_id,
        catalog_id=catalog_id,
        components=components,
        data=data,
    )

    return wrap_as_operations_envelope(ops)
