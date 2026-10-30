"""Tests for the Google A2UI Agent SDK reuse (OSS-158).

Covers the slimmed glue module (``a2ui_google_sdk``): catalog normalization,
``render_catalog_instructions`` (the prompt-rendering reuse — including that it
survives the client's non-conformant catalog, unlike strict validation), and
``parse_and_fix``-based healing; plus the adapter behaviors that engage when a
catalog is present (Google-rendered prompt + healed args). Validation itself is
the toolkit's job and is exercised in ``test_a2ui_tool.py``.
"""

from __future__ import annotations

import asyncio
import copy
import json
from typing import AsyncGenerator

import pytest
from a2ui.inference_formats.direct_json import DirectJsonPromptGenerator
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

import ag_ui_adk.a2ui_google_sdk as sdk_helper
from ag_ui_adk import CONTEXT_STATE_KEY, get_a2ui_tool
from ag_ui_adk.a2ui_google_sdk import (
    heal_json_arg,
    normalize_catalog_dict,
    render_catalog_instructions,
)
from ag_ui_adk.a2ui_tool import A2UI_SCHEMA_CONTEXT_DESCRIPTION


def _envelope_text(result) -> str:
    """``run_async`` returns the envelope as a dict (ADK serializes it as the
    bare envelope JSON); re-serialize for tests that assert on that text."""
    return result if isinstance(result, str) else json.dumps(result)


CID = "https://a2ui.org/demos/dojo/dynamic_catalog.json"

# A clean inline catalog (loose types, no internal $refs).
CLEAN_CATALOG = {
    "catalogId": CID,
    "components": {
        "Row": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "component": {"const": "Row"},
                "children": {},
            },
            "required": ["id", "component", "children"],
        },
        "HotelCard": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "component": {"const": "HotelCard"},
                "name": {},
            },
            "required": ["id", "component", "name"],
        },
    },
}

# A NON-conformant catalog: component-rooted #/properties ref that dangles under the
# catalog root (mirrors the zod-extracted client catalog that breaks strict validation).
NONCONFORMANT_CATALOG = {
    "catalogId": CID,
    "components": {
        "HotelCard": {
            "allOf": [
                {"$ref": "common_types.json#/$defs/ComponentCommon"},
                {
                    "properties": {
                        "component": {"const": "HotelCard"},
                        "name": {"$ref": "#/properties/accessibility/properties/label"},
                    },
                    "required": ["component", "name"],
                },
            ]
        }
    },
}


# --------------------------------------------------------------------------- #
# normalize_catalog_dict
# --------------------------------------------------------------------------- #


def test_normalize_inline_dict_injects_default_id():
    out = normalize_catalog_dict(
        {"components": CLEAN_CATALOG["components"]}, default_catalog_id="cat://x"
    )
    assert out["catalogId"] == "cat://x" and "Row" in out["components"]


def test_normalize_existing_id_wins():
    assert (
        normalize_catalog_dict(CLEAN_CATALOG, default_catalog_id="cat://other")[
            "catalogId"
        ]
        == CID
    )


def test_normalize_json_string():
    assert (
        normalize_catalog_dict(json.dumps(CLEAN_CATALOG), default_catalog_id=None)[
            "catalogId"
        ]
        == CID
    )


def test_normalize_non_json_string_returns_none():
    assert (
        normalize_catalog_dict("Card, Text, Row", default_catalog_id="cat://x") is None
    )


def test_normalize_legacy_list_form():
    out = normalize_catalog_dict(
        [{"name": "HotelCard", "props": {"name": {"type": "string"}}}],
        default_catalog_id="cat://x",
    )
    assert out["catalogId"] == "cat://x" and "HotelCard" in out["components"]


def test_normalize_empty_returns_none():
    assert normalize_catalog_dict({}, default_catalog_id="cat://x") is None
    assert normalize_catalog_dict([], default_catalog_id="cat://x") is None


# --------------------------------------------------------------------------- #
# render_catalog_instructions
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def clear_render_cache():
    sdk_helper._RENDER_CACHE.clear()
    yield
    sdk_helper._RENDER_CACHE.clear()


@pytest.mark.parametrize("version", ["0.8", "0.9"])
def test_render_uses_sdk_with_versioned_client_catalog(version, monkeypatch):
    catalog = copy.deepcopy(CLEAN_CATALOG)
    catalog.update(
        protocolVersion=version,
        instructions="Client instructions",
        **{
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": {"ClientType": {"type": "string"}},
        },
    )
    original = copy.deepcopy(catalog)
    calls = []
    generate = DirectJsonPromptGenerator.generate_catalog_instructions

    def record(self, *args, **kwargs):
        calls.append(self.catalogs[0].to_json())
        return generate(self, *args, **kwargs)

    monkeypatch.setattr(
        DirectJsonPromptGenerator, "generate_catalog_instructions", record
    )
    instructions = render_catalog_instructions(
        catalog, default_catalog_id="cat://other"
    )
    assert instructions is not None
    assert calls == [original]
    assert catalog == original
    rendered_catalog = json.loads(
        instructions.split("### Catalog Schema:\n", 1)[1].split("\n\n---END", 1)[0]
    )
    assert rendered_catalog == original
    protocol = json.loads(
        instructions.split("### Agent to Renderer Schema:\n", 1)[1].split("\n\n###", 1)[
            0
        ]
    )
    if version == "0.8":
        assert set(protocol["properties"]) == {
            "beginRendering",
            "surfaceUpdate",
            "dataModelUpdate",
        }
    else:
        assert {
            "CreateSurfaceMessage",
            "UpdateComponentsMessage",
            "UpdateDataModelMessage",
        } <= protocol["$defs"].keys()
        assert "DeleteSurfaceMessage" not in protocol["$defs"]
    assert "<a2ui-json>" not in instructions


def test_render_emits_schema_block_and_components_no_tag():
    instr = render_catalog_instructions(CLEAN_CATALOG, default_catalog_id=CID)
    assert instr is not None
    # Rendered as Google's schema block (markers), carrying the components — and
    # never the tag-delivery instruction (we don't use generate_system_prompt).
    assert "---BEGIN A2UI JSON SCHEMA---" in instr
    assert "HotelCard" in instr and "Row" in instr
    assert "<a2ui-json>" not in instr


@pytest.mark.parametrize(
    "common_ref",
    [
        "common_types.json#/$defs/ComponentCommon",
        (
            "https://a2ui.org/specification/v0_9/"
            "common_types.json#/$defs/ComponentCommon"
        ),
    ],
)
def test_render_includes_common_types_definitions_when_referenced(common_ref):
    # A catalog that references common types (like the real zod-extracted client
    # catalog) gets the canonical common-types DEFINITIONS bundled into the prompt —
    # the definitions the injected catalog only references. That's the reuse value.
    catalog = json.loads(json.dumps(NONCONFORMANT_CATALOG))
    catalog["components"]["HotelCard"]["allOf"][0]["$ref"] = common_ref
    instr = render_catalog_instructions(catalog, default_catalog_id=CID)
    assert instr is not None
    assert "Common Types Schema" in instr
    common_types = instr.split("### Common Types Schema:\n", 1)[1].split(
        "### Catalog Schema:", 1
    )[0]
    assert "ComponentCommon" in json.loads(common_types)["$defs"]
    assert {"DynamicString", "DataBinding"} <= json.loads(common_types)["$defs"].keys()


def test_render_survives_nonconformant_catalog():
    # Strict validation chokes on this; rendering just serializes, so it must NOT.
    instr = render_catalog_instructions(NONCONFORMANT_CATALOG, default_catalog_id=CID)
    assert instr is not None and "HotelCard" in instr


def test_render_unusable_source_returns_none():
    assert (
        render_catalog_instructions("Card, Text, Row", default_catalog_id=CID) is None
    )
    assert render_catalog_instructions({}, default_catalog_id=CID) is None


def test_render_is_cached():
    a = render_catalog_instructions(CLEAN_CATALOG, default_catalog_id=CID)
    b = render_catalog_instructions(CLEAN_CATALOG, default_catalog_id=CID)
    assert a is b


def test_render_cache_isolated_by_protocol_version():
    prompts = [
        render_catalog_instructions(
            {**CLEAN_CATALOG, "protocolVersion": version}, default_catalog_id=CID
        )
        for version in ("0.8", "0.9")
    ]
    assert all(prompts)
    assert prompts[0] != prompts[1]


def test_render_failure_is_logged_and_not_replaced_with_server_catalog(
    monkeypatch, caplog
):
    def fail(*args, **kwargs):
        raise RuntimeError("SDK render failed")

    monkeypatch.setattr(
        DirectJsonPromptGenerator, "generate_catalog_instructions", fail
    )
    assert render_catalog_instructions(CLEAN_CATALOG, default_catalog_id=CID) is None
    assert "SDK render failed" in caplog.text
    assert "falling back to the raw catalog" in caplog.text


# --------------------------------------------------------------------------- #
# heal_json_arg
# --------------------------------------------------------------------------- #


def test_heal_smart_quotes_and_trailing_comma():
    assert heal_json_arg(
        "[{“id”:“root”,“component”:“Text”,“text”:“Hi”,}]", expect="list"
    ) == [{"id": "root", "component": "Text", "text": "Hi"}]


def test_heal_dict_unwraps_single_object():
    assert heal_json_arg("{}", expect="dict") == {}
    assert heal_json_arg('{"items":[1,2]}', expect="dict") == {"items": [1, 2]}


def test_heal_hard_failure_raises():
    with pytest.raises(ValueError):
        heal_json_arg("[{not valid", expect="list")


# --------------------------------------------------------------------------- #
# Adapter end-to-end: render into prompt + healing
# --------------------------------------------------------------------------- #


class _RenderLlm(BaseLlm):
    """Yields one ``render_a2ui`` call with ``args``; records the prompt it saw."""

    args: dict = {}
    prompts: list = []

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        try:
            self.prompts.append(llm_request.contents[-1].parts[0].text)
        except (AttributeError, IndexError, TypeError):
            self.prompts.append(None)
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            name="render_a2ui", args=self.args
                        )
                    )
                ],
            ),
            partial=False,
            turn_complete=True,
        )


class _Ctx:
    def __init__(self, state=None):
        self.state = state if state is not None else {}


@pytest.mark.asyncio
async def test_client_catalog_is_google_rendered_into_prompt():
    model = _RenderLlm(
        model="m",
        args={
            "surfaceId": "s",
            "components": [{"id": "root", "component": "HotelCard", "name": "Ritz"}],
        },
    )
    tool = get_a2ui_tool({"model": model, "default_catalog_id": CID})
    tool.event_queue = asyncio.Queue()
    state = {
        CONTEXT_STATE_KEY: [
            {
                "description": A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                "value": json.dumps(CLEAN_CATALOG),
            }
        ]
    }
    await tool.run_async(args={"intent": "create"}, tool_context=_Ctx(state=state))
    prompt = model.prompts[0]
    # The client catalog was rendered via Google's schema block (markers prove it
    # wasn't dumped raw), carrying the components — and without the tag instruction.
    assert "---BEGIN A2UI JSON SCHEMA---" in prompt
    assert "HotelCard" in prompt
    assert "<a2ui-json>" not in prompt


@pytest.mark.asyncio
async def test_host_catalog_wins_over_context_and_accepts_nonconformant_refs():
    model = _RenderLlm(
        model="m",
        args={
            "surfaceId": "s",
            "components": [{"id": "root", "component": "HotelCard", "name": "Ritz"}],
        },
    )
    tool = get_a2ui_tool({"model": model, "catalog": NONCONFORMANT_CATALOG})
    tool.event_queue = asyncio.Queue()
    state = {
        CONTEXT_STATE_KEY: [
            {
                "description": A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                "value": json.dumps(
                    {"catalogId": "cat://other", "components": {"OtherCard": {}}}
                ),
            }
        ]
    }
    result = await tool.run_async(args={"intent": "create"}, tool_context=_Ctx(state))
    assert "a2ui_operations" in _envelope_text(result)
    assert "---BEGIN A2UI JSON SCHEMA---" in model.prompts[0]
    assert "HotelCard" in model.prompts[0]
    assert "OtherCard" not in model.prompts[0]
    assert "DynamicString" in model.prompts[0]


@pytest.mark.asyncio
async def test_sdk_rendered_catalog_still_rejects_unknown_components():
    model = _RenderLlm(
        model="m",
        args={
            "surfaceId": "s",
            "components": [{"id": "root", "component": "NotInClientCatalog"}],
        },
    )
    tool = get_a2ui_tool({"model": model, "catalog": CLEAN_CATALOG})
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={"intent": "create"}, tool_context=_Ctx())
    envelope = json.loads(_envelope_text(result))
    assert envelope["code"] == "a2ui_recovery_exhausted"
    assert "a2ui_operations" not in envelope
    assert "---BEGIN A2UI JSON SCHEMA---" in model.prompts[0]


@pytest.mark.asyncio
async def test_sdk_render_failure_preserves_raw_context_prompt(monkeypatch, caplog):
    def fail(*args, **kwargs):
        raise RuntimeError("SDK render failed")

    monkeypatch.setattr(
        DirectJsonPromptGenerator, "generate_catalog_instructions", fail
    )
    model = _RenderLlm(
        model="m",
        args={
            "surfaceId": "s",
            "components": [{"id": "root", "component": "HotelCard"}],
        },
    )
    tool = get_a2ui_tool({"model": model})
    tool.event_queue = asyncio.Queue()
    state = {
        CONTEXT_STATE_KEY: [
            {
                "description": A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                "value": json.dumps(CLEAN_CATALOG),
            }
        ]
    }
    await tool.run_async(args={"intent": "create"}, tool_context=_Ctx(state))
    assert "SDK render failed" in caplog.text
    assert "HotelCard" in model.prompts[0]
    assert "---BEGIN A2UI JSON SCHEMA---" not in model.prompts[0]


@pytest.mark.asyncio
async def test_freeform_string_args_are_healed_and_committed():
    # Gemini returns components as a JSON STRING with smart quotes + trailing comma.
    model = _RenderLlm(
        model="m",
        args={
            "surfaceId": "s",
            "components": "[{“id”:“root”,“component”:“Text”,“text”:“Hi”,}]",
        },
    )
    tool = get_a2ui_tool({"model": model})
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={"intent": "create"}, tool_context=_Ctx())
    assert "a2ui_operations" in _envelope_text(result)
    env = json.loads(_envelope_text(result))
    comps = next(
        op["updateComponents"]["components"]
        for op in env["a2ui_operations"]
        if "updateComponents" in op
    )
    assert comps[0]["component"] == "Text" and comps[0]["id"] == "root"


EXPRESS_CATALOG = {
    "catalogId": CID,
    "components": {
        "Text": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "component": {"const": "Text"},
                "text": {"type": "string"},
            },
            "required": ["id", "component", "text"],
        },
    },
}


class _ExpressLlm(BaseLlm):
    """Only the model boundary is doubled; Express compilation stays real."""

    scripts: list = []
    requests: list = []
    queues: list = []
    emitted_before_completion: bool = False

    async def generate_content_async(self, llm_request, stream=False):
        self.requests.append(llm_request)
        script = self.scripts[min(len(self.requests) - 1, len(self.scripts) - 1)]
        for chunk in script:
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text=chunk)]),
                partial=True,
            )
            if self.queues:
                self.emitted_before_completion |= any(
                    event.type == "ACTIVITY_SNAPSHOT"
                    and "a2ui_operations" in event.content
                    for event in self.queues[0]._queue
                )
        yield LlmResponse(
            content=types.Content(role="model", parts=[]),
            partial=False,
            turn_complete=True,
        )


@pytest.mark.asyncio
async def test_express_streams_compiled_components_before_model_finishes():
    model = _ExpressLlm(
        model="express",
        scripts=[
            [
                '<a2ui>\nroot = Text("Hel',
                'lo")\n',
                "</a2ui>",
            ]
        ],
    )
    tool = get_a2ui_tool(
        {"model": model, "catalog": EXPRESS_CATALOG, "inference_format": "express"}
    )
    tool.event_queue = asyncio.Queue()
    model.queues.append(tool.event_queue)
    result = await tool.run_async(args={"intent": "create"}, tool_context=_Ctx())
    assert (
        model.emitted_before_completion
    ), "Express must stream validated JSON before the model completes"
    assert "a2ui_operations" in result
    ops = result["a2ui_operations"]
    assert any(
        op.get("updateComponents", {}).get("components", [{}])[0].get("text") == "Hello"
        for op in ops
    )
    assert (
        next(op["createSurface"]["catalogId"] for op in ops if "createSurface" in op)
        == CID
    )
    request = model.requests[0]
    assert not request.config.tools
    assert request.config.tool_config is None
    assert "TEXT" in request.config.response_modalities
    assert "A2UI Express" in request.config.system_instruction
    assert "MUST call the render_a2ui tool" not in request.config.system_instruction
    snapshots = [
        event
        for event in tool.event_queue._queue
        if event.type == "ACTIVITY_SNAPSHOT" and "a2ui_operations" in event.content
    ]
    assert snapshots
    assert len({event.message_id for event in snapshots}) == 1
    assert all(
        event.activity_type == "a2ui-surface" and event.replace for event in snapshots
    )
    for event in snapshots:
        payload = json.dumps(event.content)
        assert "<a2ui>" not in payload
        assert "Text(" not in payload


@pytest.mark.asyncio
async def test_express_compile_failure_retries_with_real_diagnostics():
    model = _ExpressLlm(
        model="express",
        scripts=[
            ['<a2ui>\nroot = UnknownComponent("Hi")\n</a2ui>'],
            ['<a2ui>\nroot = Text("Recovered")\n</a2ui>'],
        ],
    )
    records = []
    tool = get_a2ui_tool(
        {
            "model": model,
            "catalog": EXPRESS_CATALOG,
            "inference_format": "express",
            "on_a2ui_attempt": records.append,
        }
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={}, tool_context=_Ctx())
    assert "a2ui_operations" in result
    assert len(records) == 2 and records[0]["ok"] is False and records[1]["ok"] is True
    assert "UnknownComponent" in model.requests[1].config.system_instruction
    assert "did not call render_a2ui" not in model.requests[1].config.system_instruction


@pytest.mark.asyncio
async def test_express_truncated_block_is_a_retryable_failure():
    model = _ExpressLlm(model="express", scripts=[['<a2ui>\nroot = Text("partial")\n']])
    tool = get_a2ui_tool(
        {
            "model": model,
            "catalog": EXPRESS_CATALOG,
            "inference_format": "express",
            "recovery": {"maxAttempts": 1},
        }
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={}, tool_context=_Ctx())
    assert result["code"] == "a2ui_recovery_exhausted"
    diagnostics = json.dumps(result["attempts"])
    assert "express" in diagnostics.lower()
    assert "did not call render_a2ui" not in diagnostics
    assert "a2ui_operations" not in result


def test_public_express_compiler_uses_official_validation_and_catalog_id():
    from ag_ui_adk import compile_a2ui_express

    ops = compile_a2ui_express(
        'root = Text("Fixed")', catalog=EXPRESS_CATALOG, surface_id="fixed"
    )
    assert ops[0]["createSurface"] == {"surfaceId": "fixed", "catalogId": CID}
    assert ops[1]["updateComponents"]["components"] == [
        {"id": "root", "component": "Text", "text": "Fixed"}
    ]
    with pytest.raises(ValueError, match="Unknown|unknown|defined|catalog"):
        compile_a2ui_express('root = Unknown("Bad")', catalog=EXPRESS_CATALOG)


def test_express_component_local_refs_preserve_constraints_and_source_order():
    from ag_ui_adk import compile_a2ui_express

    catalog = {
        "catalogId": CID,
        "components": {
            "Note": {
                "type": "object",
                "properties": {
                    "text": {"$ref": "#/properties/help"},
                    "help": {"type": "string"},
                },
                "required": ["text"],
            }
        },
    }
    original = copy.deepcopy(catalog)
    ops = compile_a2ui_express(
        'root = Note("First positional property")', catalog=catalog
    )
    assert (
        ops[1]["updateComponents"]["components"][0]["text"]
        == "First positional property"
    )
    assert catalog == original
    with pytest.raises(ValueError):
        compile_a2ui_express("root = Note(42)", catalog=catalog)


@pytest.mark.asyncio
async def test_express_preserves_data_bindings_actions_and_outer_activity_id():
    from types import SimpleNamespace

    dsl = '<a2ui>\n$/form/name = "Ada"\nroot = Column([TextField("Name", $/form/name), Button(Text("Submit"), action=Event("submit", {name: $/form/name}))])\n</a2ui>'
    model = _ExpressLlm(model="express", scripts=[[dsl]])
    tool = get_a2ui_tool({"model": model, "inference_format": "express"})
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(
        args={}, tool_context=SimpleNamespace(state={}, function_call_id="outer-call")
    )
    ops = result["a2ui_operations"]
    components = next(
        op["updateComponents"]["components"] for op in ops if "updateComponents" in op
    )
    assert next(c["value"] for c in components if c["component"] == "TextField") == {
        "path": "/form/name"
    }
    assert next(c["action"] for c in components if c["component"] == "Button") == {
        "event": {"name": "submit", "context": {"name": {"path": "/form/name"}}}
    }
    assert next(
        op["updateDataModel"]["value"] for op in ops if "updateDataModel" in op
    ) == {"form": {"name": "Ada"}}
    snapshots = [
        event for event in tool.event_queue._queue if event.type == "ACTIVITY_SNAPSHOT"
    ]
    assert {event.message_id for event in snapshots} == {"a2ui-surface-outer-call"}
    assert snapshots[-1].content == result


@pytest.mark.asyncio
async def test_express_updates_existing_surface_without_recreating_it():
    from types import SimpleNamespace
    from google.adk.events import Event

    prior = {
        "a2ui_operations": [
            {
                "version": "v0.9",
                "createSurface": {"surfaceId": "existing", "catalogId": CID},
            },
            {
                "version": "v0.9",
                "updateComponents": {
                    "surfaceId": "existing",
                    "components": [{"id": "root", "component": "Text", "text": "Old"}],
                },
            },
        ]
    }
    event = Event(
        author="agent",
        content=types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        name="generate_a2ui", response=prior
                    )
                )
            ],
        ),
    )
    context = SimpleNamespace(
        state={},
        session=SimpleNamespace(events=[event]),
        function_call_id="update-call",
    )
    model = _ExpressLlm(
        model="express",
        scripts=[
            [
                '<a2ui>\nsurface("existing", update=true)\nroot = Text("Updated")\n</a2ui>'
            ]
        ],
    )
    tool = get_a2ui_tool(
        {"model": model, "catalog": EXPRESS_CATALOG, "inference_format": "express"}
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(
        args={
            "intent": "update",
            "target_surface_id": "existing",
            "changes": "change the text",
        },
        tool_context=context,
    )
    assert "a2ui_operations" in result
    assert all("createSurface" not in op for op in result["a2ui_operations"])
    assert result["a2ui_operations"][0]["updateComponents"]["surfaceId"] == "existing"
    assert (
        result["a2ui_operations"][0]["updateComponents"]["components"][0]["text"]
        == "Updated"
    )
    assert "Old" in model.requests[0].config.system_instruction


class _CancellableExpressLlm(BaseLlm):
    started: object = None
    cancelled: object = None

    async def generate_content_async(self, llm_request, stream=False):
        try:
            yield LlmResponse(
                content=types.Content(
                    parts=[types.Part(text='<a2ui>\nroot = Text("Wait')]
                ),
                partial=True,
            )
            self.started.set()
            await asyncio.Event().wait()
        finally:
            self.cancelled.set()


@pytest.mark.asyncio
async def test_cancelling_express_generation_cancels_model_without_retries():
    model = _CancellableExpressLlm(
        model="express", started=asyncio.Event(), cancelled=asyncio.Event()
    )
    attempts = []
    tool = get_a2ui_tool(
        {
            "model": model,
            "catalog": EXPRESS_CATALOG,
            "inference_format": "express",
            "on_a2ui_attempt": attempts.append,
        }
    )
    tool.event_queue = asyncio.Queue()
    task = asyncio.create_task(tool.run_async(args={}, tool_context=_Ctx()))
    await asyncio.wait_for(model.started.wait(), timeout=3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.wait_for(model.cancelled.wait(), timeout=3)
    count = tool.event_queue.qsize()
    await asyncio.sleep(0.02)
    assert tool.event_queue.qsize() == count
    assert attempts == []


@pytest.mark.parametrize(
    "dsl",
    [
        "root = Text(",
        'root = Text("Hi", nonexistent="bad")',
        'root = Column(["missing"])',
        'deleteSurface("default")',
    ],
)
@pytest.mark.asyncio
async def test_invalid_express_never_paints_an_invalid_snapshot(dsl):
    model = _ExpressLlm(model="express", scripts=[[f"<a2ui>\n{dsl}\n</a2ui>"]])
    tool = get_a2ui_tool(
        {"model": model, "inference_format": "express", "recovery": {"maxAttempts": 1}}
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={}, tool_context=_Ctx())
    assert result["code"] == "a2ui_recovery_exhausted"
    assert not any(
        "a2ui_operations" in event.content for event in tool.event_queue._queue
    )


@pytest.mark.asyncio
async def test_express_replaces_partial_attempt_with_retry_then_same_final_activity():
    from types import SimpleNamespace

    model = _ExpressLlm(
        model="express",
        scripts=[
            [
                '<a2ui>\nroot = Text("Valid partial")\n',
                'bad = UnknownComponent("Bad")\n</a2ui>',
            ],
            ['<a2ui>\nroot = Text("Recovered")\n</a2ui>'],
        ],
    )
    tool = get_a2ui_tool(
        {"model": model, "catalog": EXPRESS_CATALOG, "inference_format": "express"}
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(
        args={}, tool_context=SimpleNamespace(state={}, function_call_id="one-bubble")
    )
    activities = list(tool.event_queue._queue)
    assert {event.message_id for event in activities} == {"a2ui-surface-one-bubble"}
    assert all(event.replace for event in activities)
    retry_index = next(
        i
        for i, event in enumerate(activities)
        if event.content.get("status") == "retrying"
    )
    assert "a2ui_operations" in activities[retry_index - 1].content
    assert activities[-1].content == result
    assert "Recovered" in json.dumps(result)


class _AggregatedExpressLlm(BaseLlm):
    async def generate_content_async(self, llm_request, stream=False):
        raw = '<a2ui>\nroot = Text("One response")\n</a2ui>'
        yield LlmResponse(
            content=types.Content(parts=[types.Part(text=raw)]), partial=True
        )
        yield LlmResponse(
            content=types.Content(parts=[types.Part(text=raw)]),
            partial=False,
            turn_complete=True,
        )


@pytest.mark.asyncio
async def test_express_ignores_adk_terminal_aggregate_after_partial_chunks():
    tool = get_a2ui_tool(
        {
            "model": _AggregatedExpressLlm(model="aggregate"),
            "catalog": EXPRESS_CATALOG,
            "inference_format": "express",
        }
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={}, tool_context=_Ctx())
    assert "a2ui_operations" in result
    assert len(tool.event_queue._queue) == 1


class _TransportErrorLlm(BaseLlm):
    async def generate_content_async(self, llm_request, stream=False):
        raise ValueError("transport configuration error")
        yield  # pragma: no cover


@pytest.mark.asyncio
async def test_express_transport_errors_do_not_become_compiler_retries():
    attempts = []
    tool = get_a2ui_tool(
        {
            "model": _TransportErrorLlm(model="error"),
            "catalog": EXPRESS_CATALOG,
            "inference_format": "express",
            "on_a2ui_attempt": attempts.append,
        }
    )
    tool.event_queue = asyncio.Queue()
    with pytest.raises(ValueError, match="transport configuration error"):
        await tool.run_async(args={}, tool_context=_Ctx())
    assert attempts == []


@pytest.mark.asyncio
async def test_express_data_snapshots_are_immutable_across_later_chunks():
    model = _ExpressLlm(
        model="express",
        scripts=[
            [
                '<a2ui>\n$/name = "Ada"\nroot = Text("Hello")\n',
                '$/name = "Grace"\n',
                "</a2ui>",
            ]
        ],
    )
    tool = get_a2ui_tool(
        {"model": model, "catalog": EXPRESS_CATALOG, "inference_format": "express"}
    )
    tool.event_queue = asyncio.Queue()
    await tool.run_async(args={}, tool_context=_Ctx())
    names = []
    for event in tool.event_queue._queue:
        for op in event.content.get("a2ui_operations", []):
            if "updateDataModel" in op:
                names.append(op["updateDataModel"]["value"]["name"])
    assert names == ["Ada", "Grace"]
