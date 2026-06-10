"""A2UI subagent tool factory for Google ADK agents (OSS-158).

Thin adapter over ``ag-ui-a2ui-toolkit`` — the heavy lifting (op builders,
prompt assembly, history walkers, output envelope, and the validate→retry
recovery loop) lives in the toolkit. This adapter owns only the ADK-specific
glue: the ``BaseTool`` decorator, runtime/state access, model bind + invoke,
and — unlike LangGraph, which gets it free via langchain's ``astream_events`` —
explicit emission of the nested ``render_a2ui`` tool-call stream onto the run's
event queue so the middleware paint gate and client see progressive components.

Mirrors the LangGraph ``get_a2ui_tools`` factory: it takes the shared
``A2UIToolParams`` so a new toolkit knob reaches this adapter with no signature
change.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Optional

from google.adk.models.llm_request import LlmRequest
from google.adk.tools import BaseTool
from google.genai import types

from ag_ui.core import (
    EventType,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)

from ag_ui_a2ui_toolkit import (
    A2UIToolParams,
    RENDER_A2UI_TOOL_DEF,
    build_a2ui_envelope,
    prepare_a2ui_request,
    resolve_a2ui_tool_params,
    run_a2ui_generation_with_recovery,
    wrap_error_envelope,
)

from .event_translator import adk_events_to_messages
from .session_manager import CONTEXT_STATE_KEY

# The inner structured-output tool the subagent is forced to call.
_RENDER_A2UI_NAME = "render_a2ui"

# Description the A2UI middleware stamps on the schema context entry. MUST stay
# byte-identical to the middleware's exported A2UI_SCHEMA_CONTEXT_DESCRIPTION
# (middlewares/a2ui-middleware/src/index.ts) and the LangGraph adapter's copy —
# exact-equality match routes the schema into state["ag-ui"]["a2ui_schema"]
# instead of leaking it into generic context. Any drift silently misroutes it.
A2UI_SCHEMA_CONTEXT_DESCRIPTION = (
    "A2UI Component Schema — available components for generating UI surfaces. "
    "Use these component names and properties when creating A2UI operations."
)


class A2UISubAgentTool(BaseTool):
    """ADK tool that delegates A2UI surface generation to a forced-tool-call
    subagent invocation and drives the toolkit recovery loop.

    The recovery loop (``run_a2ui_generation_with_recovery``) is synchronous; the
    model stream and event-queue emission are async. ``run_async`` bridges the
    two by running the loop on a worker thread (``asyncio.to_thread``) whose
    synchronous ``invoke_subagent`` callback drives the async per-attempt stream
    back on the run's event loop (``run_coroutine_threadsafe``). This keeps the
    published toolkit untouched.
    """

    def __init__(self, cfg: dict):
        super().__init__(
            name=cfg["tool_name"],
            description=cfg["tool_description"],
            is_long_running=False,
        )
        self._cfg = cfg
        self._model = cfg["model"]
        self._guidelines = cfg["guidelines"]
        self._default_surface_id = cfg["default_surface_id"]
        self._default_catalog_id = cfg["default_catalog_id"]
        self._catalog = cfg["catalog"]
        self._recovery = cfg["recovery"]
        self._on_a2ui_attempt = cfg["on_a2ui_attempt"]
        # Injected per-run by ADKAgent so the tool can emit nested tool-call
        # events onto the active run's stream.
        self.event_queue = None

    def for_run(self, event_queue: Any) -> "A2UISubAgentTool":
        """Return a per-run clone bound to ``event_queue``.

        The construction-time tool is shared across concurrent runs; ADKAgent
        swaps in this clone per run so each emits onto its own stream without
        mutating the shared instance (mirrors the ClientProxyToolset swap).
        """
        clone = A2UISubAgentTool(self._cfg)
        clone.event_queue = event_queue
        return clone

    def _get_declaration(self) -> Optional[types.FunctionDeclaration]:
        """Declare ``generate_a2ui`` to the parent agent's planner."""
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "intent": types.Schema(
                        type=types.Type.STRING,
                        description=(
                            "'create' to render a new surface, or 'update' to "
                            "modify a surface already rendered in this conversation."
                        ),
                    ),
                    "target_surface_id": types.Schema(
                        type=types.Type.STRING,
                        description="Surface id to modify when intent='update'.",
                    ),
                    "changes": types.Schema(
                        type=types.Type.STRING,
                        description="Natural-language changes to apply on update.",
                    ),
                },
            ),
        )

    async def run_async(self, *, args: dict[str, Any], tool_context: Any) -> Any:
        """Generate or edit an A2UI surface, returning the operations envelope."""
        intent = args.get("intent", "create")
        target_surface_id = args.get("target_surface_id")
        changes = args.get("changes")

        events = self._session_events(tool_context)
        # AG-UI messages drive prepare_a2ui_request's prior-surface lookup
        # (intent="update"); the genai conversation drives the subagent call.
        messages = adk_events_to_messages(events)
        conversation = self._conversation_contents(events)
        state = self._state_view(tool_context)

        prep = prepare_a2ui_request(
            intent=intent,
            target_surface_id=target_surface_id,
            changes=changes,
            messages=messages,
            state=state,
            guidelines=self._guidelines,
        )
        if prep.get("error"):
            return wrap_error_envelope(prep["error"])

        # One stable nested tool-call id, reused across every recovery attempt so
        # the middleware/client swap the in-progress surface in place rather than
        # stacking N tool calls.
        surface_tool_call_id = f"a2ui-render-{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()

        def _invoke_subagent(prompt: str, attempt: int) -> Optional[dict]:
            future = asyncio.run_coroutine_threadsafe(
                self._stream_one_attempt(
                    prompt, attempt, surface_tool_call_id, conversation
                ),
                loop,
            )
            return future.result()

        def _build_envelope(generated: dict) -> str:
            return build_a2ui_envelope(
                args=generated,
                is_update=prep["is_update"],
                target_surface_id=target_surface_id,
                prior=prep.get("prior"),
                default_surface_id=self._default_surface_id,
                default_catalog_id=self._default_catalog_id,
            )

        result = await asyncio.to_thread(
            run_a2ui_generation_with_recovery,
            base_prompt=prep["prompt"],
            catalog=self._catalog,
            config=self._recovery,
            invoke_subagent=_invoke_subagent,
            build_envelope=_build_envelope,
            on_attempt=self._on_a2ui_attempt,
        )
        return result["envelope"]

    async def _stream_one_attempt(
        self, prompt: str, attempt: int, tool_call_id: str, conversation: list
    ) -> Optional[dict]:
        """Invoke the subagent once, streaming its ``render_a2ui`` call onto the
        run queue as nested ``TOOL_CALL_*`` events; return the generated args."""
        await self.event_queue.put(
            ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=_RENDER_A2UI_NAME,
            )
        )

        llm_request = self._build_llm_request(prompt, conversation)
        final_args: Optional[dict] = None
        async for response in self._model.generate_content_async(
            llm_request, stream=True
        ):
            fc = self._extract_render_fc(response)
            if fc is not None and getattr(fc, "args", None):
                final_args = self._coerce_freeform_args(dict(fc.args))

        # Atomic per-attempt paint: emit the complete args once. (Real per-delta
        # streaming for Gemini-3 partial_args is layered on separately.)
        if final_args is not None:
            await self.event_queue.put(
                ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=tool_call_id,
                    delta=json.dumps(final_args),
                )
            )

        await self.event_queue.put(
            ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id,
            )
        )
        return final_args

    def _build_llm_request(self, prompt: str, conversation: list) -> LlmRequest:
        """Build the forced-``render_a2ui`` request, mirroring the LangGraph
        adapter's ``[SystemMessage(prompt), *messages]``: the assembled subagent
        prompt rides as ``system_instruction`` and the real conversation turns are
        the request ``contents``.
        """
        # Free-form payload schema (vs the shared RENDER_A2UI_TOOL_DEF's typed
        # `components: array<object>`): Gemini's function-calling fills typed args
        # STRICTLY and emits empty `{}` for a property-less array-of-object. So we
        # declare components/data as STRING — the model writes the full A2UI JSON
        # free-form (guided by the system prompt), exactly the payload shape the
        # ADK reference (a2ui rizzcharts) uses. _coerce_freeform_args parses it back
        # into the structured dict the toolkit validates. The shared
        # RENDER_A2UI_TOOL_DEF stays typed for LangGraph/OpenAI, which fill loose
        # schemas from the prose; this string shape is ADK/Gemini-specific glue.
        declaration = types.FunctionDeclaration(
            name=_RENDER_A2UI_NAME,
            description=RENDER_A2UI_TOOL_DEF["function"]["description"],
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "surfaceId": types.Schema(
                        type=types.Type.STRING,
                        description="Unique surface identifier.",
                    ),
                    "components": types.Schema(
                        type=types.Type.STRING,
                        description=(
                            "The A2UI v0.9 component array as a JSON string, e.g. "
                            '\'[{"id":"root","component":"Text","text":"Hi"}]\'. '
                            "The root component must have id 'root'."
                        ),
                    ),
                    "data": types.Schema(
                        type=types.Type.STRING,
                        description=(
                            "Optional surface data model as a JSON string, e.g. "
                            "'{\"items\":[...]}'. Use '{}' when there is none."
                        ),
                    ),
                },
                required=["surfaceId", "components"],
            ),
        )
        config = types.GenerateContentConfig(
            system_instruction=prompt,
            tools=[types.Tool(function_declarations=[declaration])],
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.ANY,
                    allowed_function_names=[_RENDER_A2UI_NAME],
                )
            ),
        )
        # Fall back to carrying the prompt as the user turn only when there is no
        # conversation (defensive — a real run always has the triggering message).
        contents = list(conversation) if conversation else [
            types.Content(role="user", parts=[types.Part(text=prompt)])
        ]
        return LlmRequest(
            model=getattr(self._model, "model", None),
            contents=contents,
            config=config,
        )

    @staticmethod
    def _coerce_freeform_args(args: dict) -> dict:
        """Parse the free-form JSON-string ``components``/``data`` Gemini returns
        back into the structured list/dict the toolkit validates and emits.

        A model may also return them already-structured (e.g. inline) — those are
        left untouched. Unparseable strings are left as-is so the toolkit's
        validator rejects them (non-list / non-dict) and the recovery loop retries
        rather than committing garbage."""
        for key in ("components", "data"):
            value = args.get(key)
            if isinstance(value, str):
                try:
                    args[key] = json.loads(value)
                except (ValueError, TypeError):
                    pass
        return args

    @staticmethod
    def _extract_render_fc(response: Any) -> Any:
        """Return the ``render_a2ui`` FunctionCall part of an LlmResponse, if any."""
        content = getattr(response, "content", None)
        if content is None:
            return None
        for part in getattr(content, "parts", None) or []:
            fc = getattr(part, "function_call", None)
            if fc is not None and getattr(fc, "name", None) == _RENDER_A2UI_NAME:
                return fc
        return None

    @staticmethod
    def _session_events(tool_context: Any) -> list:
        """The ADK session's event list, accessed defensively across context shapes."""
        session = getattr(tool_context, "session", None)
        if session is None:
            ctx = getattr(tool_context, "_invocation_context", None)
            session = getattr(ctx, "session", None)
        return list(getattr(session, "events", None) or [])

    @staticmethod
    def _conversation_contents(events: list) -> list:
        """The conversational genai ``Content`` turns to forward to the subagent.

        Mirrors LangGraph's ``*messages``: user/model text turns in order, skipping
        partial chunks and the tool-call/function-response machinery (the in-flight
        generate_a2ui call and any tool results) so the subagent sees the request,
        not the plumbing."""
        contents: list = []
        for ev in events:
            if getattr(ev, "partial", False):
                continue
            content = getattr(ev, "content", None)
            parts = getattr(content, "parts", None)
            if not parts:
                continue
            has_text = any(getattr(p, "text", None) for p in parts)
            has_calls = bool(ev.get_function_calls()) if hasattr(ev, "get_function_calls") else False
            has_responses = bool(ev.get_function_responses()) if hasattr(ev, "get_function_responses") else False
            if has_text and not has_calls and not has_responses:
                contents.append(content)
        return contents

    def _state_view(self, tool_context: Any) -> dict:
        """Remap ADK session context into the ``state['ag-ui']`` shape the
        toolkit's ``build_context_prompt`` expects.

        The ADK middleware stores AG-UI context (a flat ``{description, value}``
        list) under ``CONTEXT_STATE_KEY``. The A2UI schema entry (matched by its
        exact description) is routed to ``ag-ui.a2ui_schema`` so it renders as
        the "Available Components" section rather than generic context — mirrors
        the LangGraph adapter's remap.
        """
        state = getattr(tool_context, "state", None)
        raw_context: Any = []
        if state is not None:
            try:
                raw_context = state.get(CONTEXT_STATE_KEY) or []
            except Exception:
                raw_context = []

        regular_context: list = []
        schema_value: Optional[str] = None
        for entry in raw_context:
            if isinstance(entry, dict):
                desc = entry.get("description", "")
                value = entry.get("value", "")
            else:
                desc = getattr(entry, "description", "")
                value = getattr(entry, "value", "")
            if desc == A2UI_SCHEMA_CONTEXT_DESCRIPTION:
                schema_value = value
            else:
                regular_context.append(entry)

        ag_ui: dict = {"context": regular_context}
        if schema_value is not None:
            ag_ui["a2ui_schema"] = schema_value
        return {"ag-ui": ag_ui}


def get_a2ui_tool(params: A2UIToolParams) -> BaseTool:
    """Build an ADK tool that delegates A2UI surface generation to a subagent.

    Args:
        params: Shared ``A2UIToolParams`` (``model`` + behavior knobs). The
            toolkit owns the shape and fills defaults via
            ``resolve_a2ui_tool_params``; every framework adapter takes this
            exact params type, so a new knob reaches this adapter with no
            signature change. ``model`` is the ADK ``BaseLlm`` the subagent
            invokes for structured A2UI output.

    Returns:
        An ADK ``BaseTool`` ready to add to an ``LlmAgent``'s ``tools`` list.
    """
    cfg = resolve_a2ui_tool_params(params)
    return A2UISubAgentTool(cfg)
