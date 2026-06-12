"""Streaming A2UI via Google's A2uiStreamParser (proof-point Option A).

Where the other Google demo (`send_a2ui_json_to_client`) is atomic, this one shows
Google's **prompt-based streaming** path: the model emits A2UI JSON inline in its
response text wrapped in `<a2ui-json>…</a2ui-json>`, and Google's `A2uiStreamParser`
yields A2UI messages incrementally (createSurface → updateComponents *with placeholder
components for forward refs* → growing updateDataModel) with `PayloadFixer` healing.

Bridge to the dojo: we accumulate the parser's incremental messages (upsert components
by id, track the latest data model) and emit a cumulative `a2ui-surface`
`ACTIVITY_SNAPSHOT` (`replace: true`) on every yield. The client's A2UI renderer paints
each snapshot, so the surface fills in progressively — equivalent to our render_a2ui
sub-agent's progressive paint, but driven by Google's text-stream parser.

ARCHITECTURE NOTE (the finding this demo exists to show): this path does **not** go
through the CopilotKit A2UI middleware. The middleware's progressive path expects a
`render_a2ui` tool-call with append-only, fully-valid component trees and gates on
validation — it would reject Google's forward-ref roots and can't express the
placeholder→real *replacement* protocol. So Google's streaming model routes *around*
the middleware: the agent emits the surface activity directly and the renderer paints
it. The two frameworks' streaming models don't compose; their atomic models do.
"""

from __future__ import annotations

import copy
import uuid
from typing import Any, Optional

from ag_ui.core import ActivitySnapshotEvent
from ag_ui_adk.a2ui_tool import A2UISubAgentTool
from google.adk.models.llm_request import LlmRequest
from google.genai import types

from a2ui.parser.streaming import A2uiStreamParser

from ._google_a2ui_common import A2UI_EXAMPLES, ROLE_DESCRIPTION

# Google's A2uiStreamParser validates each parsed message and REQUIRES a top-level
# "version" field; gemini omits it unless told firmly + shown an example.
_VERSION_MANDATE = (
    'CRITICAL: every A2UI message object MUST include "version":"v0.9" as a top-level '
    'field, e.g. {"version":"v0.9","createSurface":{...}}. Emit components top-down '
    "(root first, parents before children) so the surface can stream in."
)

# Activity type the dojo's A2UI renderer listens for (mirrors the middleware's
# `A2UIActivityType` in @ag-ui/a2ui-middleware). The renderer groups ops by surfaceId
# from the content, so a stable message_id + replace:true swaps the surface in place.
A2UI_ACTIVITY_TYPE = "a2ui-surface"


class GoogleA2uiStreamingTool(A2UISubAgentTool):
    """Streams a surface by parsing Google's `<a2ui-json>` text output and emitting
    progressive `a2ui-surface` ACTIVITY_SNAPSHOT events onto the run's AG-UI queue.

    Subclasses ``A2UISubAgentTool`` only to (a) be recognized by ``ADKAgent``'s
    per-run ``event_queue`` injection (it keys off ``isinstance(..., A2UISubAgentTool)``)
    and (b) reuse its static session/conversation helpers. The toolkit recovery loop is
    not used here.
    """

    def __init__(self, *, model: Any, schema_manager: Any, catalog: Any, default_catalog_id: str):
        # Reuse A2UISubAgentTool.__init__ via a minimal cfg so isinstance + helpers work.
        super().__init__(
            {
                "tool_name": "generate_a2ui_streaming",
                "tool_description": (
                    "Generate a rich A2UI surface for the user's request and stream it to "
                    "the client as it is produced."
                ),
                "model": model,
                "guidelines": None,
                "default_surface_id": "dynamic-surface",
                "default_catalog_id": default_catalog_id,
                "catalog": None,
                "recovery": None,
                "on_a2ui_attempt": None,
            }
        )
        self._g_catalog = catalog
        self._default_catalog_id = default_catalog_id
        # Google assembles the `<a2ui-json>` workflow rules + catalog schema. We append
        # the version mandate + a concrete version-bearing example (the catalog has no
        # bundled examples path, so include_examples would be a no-op).
        base_prompt = schema_manager.generate_system_prompt(
            role_description=ROLE_DESCRIPTION,
            workflow_description=_VERSION_MANDATE,
            include_schema=True,
            include_examples=False,
        )
        self._system_prompt = f"{base_prompt}\n\n{A2UI_EXAMPLES}"

    def for_run(self, event_queue: Any) -> "GoogleA2uiStreamingTool":
        clone = copy.copy(self)  # preserves subclass type + config; fresh parser per run
        clone.event_queue = event_queue
        return clone

    def _get_declaration(self) -> Optional[types.FunctionDeclaration]:
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "request": types.Schema(
                        type=types.Type.STRING,
                        description="What UI to generate (the conversation is also available).",
                    ),
                },
            ),
        )

    async def run_async(self, *, args: dict[str, Any], tool_context: Any) -> Any:
        conversation = self._conversation_contents(self._session_events(tool_context))
        contents = list(conversation) if conversation else [
            types.Content(role="user", parts=[types.Part(text=args.get("request") or "Generate the requested UI.")])
        ]
        llm_request = LlmRequest(
            model=getattr(self._model, "model", None),
            contents=contents,
            config=types.GenerateContentConfig(system_instruction=self._system_prompt),
        )

        message_id = f"a2ui-surface-stream-{uuid.uuid4().hex[:8]}"
        parser = A2uiStreamParser(catalog=self._g_catalog)
        components: dict[str, Any] = {}  # id -> component (insertion-ordered)
        data_model: dict[str, Any] = {}
        surface_id: Optional[str] = None
        catalog_id: str = self._default_catalog_id
        fed = ""  # text already handed to the parser (delta/cumulative safe)

        async def emit() -> None:
            if surface_id is None:
                return
            ops: list[dict[str, Any]] = [
                {"version": "v0.9", "createSurface": {"surfaceId": surface_id, "catalogId": catalog_id}},
                {"version": "v0.9", "updateComponents": {"surfaceId": surface_id, "components": list(components.values())}},
            ]
            if data_model:
                ops.append({"version": "v0.9", "updateDataModel": {"surfaceId": surface_id, "path": "/", "value": data_model}})
            await self.event_queue.put(
                ActivitySnapshotEvent(
                    message_id=message_id,
                    activity_type=A2UI_ACTIVITY_TYPE,
                    content={"a2ui_operations": ops},
                    replace=True,
                )
            )

        async for resp in self._model.generate_content_async(llm_request, stream=True):
            parts = getattr(getattr(resp, "content", None), "parts", None) or []
            text = "".join(getattr(p, "text", "") or "" for p in parts)
            if not text:
                continue
            # Feed only NEW text: partial chunks may be deltas or cumulative, and the
            # final non-partial response repeats the whole aggregate — `startswith`
            # covers all three without double-feeding.
            if text.startswith(fed):
                new, fed = text[len(fed):], text
            else:
                new, fed = text, fed + text
            if not new:
                continue
            for part in parser.process_chunk(new):
                for msg in (getattr(part, "a2ui_json", None) or []):
                    key = next((k for k in msg if k != "version"), None)
                    body = msg.get(key, {}) if key else {}
                    if key == "createSurface":
                        surface_id = body.get("surfaceId") or surface_id
                        catalog_id = body.get("catalogId") or catalog_id
                    elif key == "updateComponents":
                        for comp in body.get("components", []):
                            cid = comp.get("id")
                            if cid:
                                components[cid] = comp  # upsert; orphaned placeholders aren't reachable from root
                    elif key == "updateDataModel":
                        value = body.get("value")
                        if isinstance(value, dict):
                            data_model = value
                    await emit()

        await emit()  # final authoritative snapshot
        tool_context.actions.skip_summarization = True  # the surface is the answer
        return {"status": f"Streamed surface '{surface_id}'." if surface_id else "No surface produced."}
