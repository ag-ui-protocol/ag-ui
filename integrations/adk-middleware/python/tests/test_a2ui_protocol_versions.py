"""Catalog protocol selection at the ADK model, history and output boundaries."""

import asyncio
import copy
import json
from types import SimpleNamespace

import pytest
from a2ui.core import Catalog
from a2ui.utils import validate_payload
from google.adk.events import Event
from google.genai import types

from ag_ui_adk import CONTEXT_STATE_KEY, get_a2ui_tool
from ag_ui_adk.a2ui_google_sdk import compile_a2ui_express, render_catalog_instructions
from ag_ui_adk.a2ui_tool import A2UI_SCHEMA_CONTEXT_DESCRIPTION
from .test_a2ui_google_sdk import CID, EXPRESS_CATALOG, _ExpressLlm, _RenderLlm

FORMATS = ["direct_json", "express"]


def _catalog(version):
    catalog = copy.deepcopy(EXPRESS_CATALOG)
    if version is not None:
        catalog["protocolVersion"] = version
    return catalog


def _model(inference_format, *, update=False):
    if inference_format == "express":
        start = 'surface("s", update=true)\n' if update else ""
        return _ExpressLlm(
            model="scripted",
            scripts=[[f'<a2ui>\n{start}root = Text("Hel', 'lo")\n</a2ui>']],
        )
    return _RenderLlm(
        model="scripted",
        args={
            "surfaceId": "s",
            "components": [{"id": "root", "component": "Text", "text": "Hello"}],
            "data": {"name": "Ada"},
        },
    )


def _context(*envelopes, state=None):
    return SimpleNamespace(
        state=state or {},
        session=SimpleNamespace(
            events=[
                Event(
                    author="agent",
                    content=types.Content(
                        role="user",
                        parts=[
                            types.Part(
                                function_response=types.FunctionResponse(
                                    name="generate_a2ui",
                                    response={"result": json.dumps(envelope)},
                                )
                            )
                        ],
                    ),
                )
                for envelope in envelopes
            ]
        ),
    )


def _ops(version, text="Old"):
    return [
        {"version": version, "createSurface": {"surfaceId": "s", "catalogId": CID}},
        {
            "version": version,
            "updateComponents": {
                "surfaceId": "s",
                "components": [{"id": "root", "component": "Text", "text": text}],
            },
        },
        {
            "version": version,
            "updateDataModel": {"surfaceId": "s", "path": "/", "value": {}},
        },
    ]


def _calls(model):
    return model.requests if isinstance(model, _ExpressLlm) else model.prompts


@pytest.mark.parametrize("inference_format", FORMATS)
@pytest.mark.parametrize(
    "declared,wire",
    [
        (None, "v0.9"),
        ("0.9", "v0.9"),
        ("v0.9", "v0.9"),
        ("1.0", "1.0"),
        ("v1.0", "1.0"),
        ("1.0.0", "1.0"),
    ],
)
async def test_catalog_version_controls_create_and_streamed_operations(
    inference_format, declared, wire
):
    catalog = _catalog(declared)
    original = copy.deepcopy(catalog)
    model = _model(inference_format)
    tool = get_a2ui_tool(
        {
            "model": model,
            "catalog": catalog,
            "inference_format": inference_format,
            "default_surface_id": "s",
        }
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={}, tool_context=_context())
    assert "a2ui_operations" in result, result
    assert {op["version"] for op in result["a2ui_operations"]} == {wire}
    assert result["a2ui_operations"][0]["createSurface"]["catalogId"] == CID
    validate_payload([Catalog.from_json(catalog)], result["a2ui_operations"])
    assert catalog == original
    for event in tool.event_queue._queue:
        if event.type == "ACTIVITY_SNAPSHOT" and "a2ui_operations" in event.content:
            assert {op["version"] for op in event.content["a2ui_operations"]} == {wire}
    if wire == "1.0":
        prompt = (
            model.requests[0].config.system_instruction
            if inference_format == "express"
            else model.prompts[0]
        )
        assert "Generate A2UI v0.9 JSON" not in prompt
        if inference_format == "direct_json":
            assert '"1.0"' in prompt
            assert "---BEGIN A2UI JSON SCHEMA---" in prompt


@pytest.mark.parametrize("inference_format", FORMATS)
@pytest.mark.parametrize("version", ["v0.9", "1.0"])
async def test_update_preserves_protocol_across_wrapped_sparse_history(
    inference_format, version
):
    model = _model(inference_format, update=True)
    tool = get_a2ui_tool(
        {
            "model": model,
            "catalog": _catalog(version),
            "inference_format": inference_format,
        }
    )
    tool.event_queue = asyncio.Queue()
    prior = _ops(version)
    context = _context({"a2ui_operations": prior}, {"a2ui_operations": [prior[-1]]})
    result = await tool.run_async(
        args={"intent": "update", "target_surface_id": "s"}, tool_context=context
    )
    assert "a2ui_operations" in result, result
    assert all("createSurface" not in op for op in result["a2ui_operations"])
    assert {op["version"] for op in result["a2ui_operations"]} == {version}
    validate_payload(
        [Catalog.from_json(_catalog(version))], prior + result["a2ui_operations"]
    )


@pytest.mark.parametrize("inference_format", FORMATS)
@pytest.mark.parametrize("old,new", [("v0.9", "1.0"), ("1.0", "v0.9")])
async def test_cross_version_update_rejected_before_model(inference_format, old, new):
    model = _model(inference_format, update=True)
    tool = get_a2ui_tool(
        {"model": model, "catalog": _catalog(new), "inference_format": inference_format}
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(
        args={"intent": "update", "target_surface_id": "s"},
        tool_context=_context({"a2ui_operations": _ops(old)}),
    )
    assert "protocol version" in result.get("error", "").lower(), result
    assert not _calls(model)
    assert tool.event_queue.empty()


@pytest.mark.parametrize("inference_format", FORMATS)
@pytest.mark.parametrize(
    "version", [None, "", 1, True, {}, [], "garbage", "1.1", "0.8"]
)
@pytest.mark.parametrize("source", ["host", "context"])
async def test_explicit_invalid_or_unsupported_version_never_invokes_model(
    inference_format, version, source
):
    catalog = {**_catalog(None), "protocolVersion": version}
    model = _model(inference_format)
    params = {"model": model, "inference_format": inference_format}
    state = {}
    if source == "host":
        params["catalog"] = catalog
    else:
        state[CONTEXT_STATE_KEY] = [
            {
                "description": A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                "value": json.dumps(catalog),
            }
        ]
    tool = get_a2ui_tool(params)
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={}, tool_context=_context(state=state))
    assert "error" in result, result
    assert "protocol" in result["error"].lower()
    assert not _calls(model)


@pytest.mark.parametrize("version", ["1.0", "v1.0", "1.0.0"])
def test_public_compiler_follows_catalog_protocol(version):
    ops = compile_a2ui_express(
        'root = Text("Hello")', catalog=_catalog(version), surface_id="s"
    )
    assert {op["version"] for op in ops} == {"1.0"}
    validate_payload([Catalog.from_json(_catalog(version))], ops)


def test_direct_json_prompt_supports_v1_and_cache_is_version_specific():
    old = render_catalog_instructions(_catalog("v0.9"), default_catalog_id=CID)
    new = render_catalog_instructions(_catalog("1.0"), default_catalog_id=CID)
    assert old and new and old != new
    assert '"1.0"' in new


@pytest.mark.parametrize("inference_format", FORMATS)
async def test_v1_update_reads_inline_initial_state_from_compiler_history(
    inference_format,
):
    model = _model(inference_format, update=True)
    tool = get_a2ui_tool(
        {
            "model": model,
            "catalog": _catalog("1.0"),
            "inference_format": inference_format,
        }
    )
    tool.event_queue = asyncio.Queue()
    prior = {
        "a2ui_operations": [
            {
                "version": "1.0",
                "createSurface": {
                    "surfaceId": "s",
                    "catalogId": CID,
                    "components": [
                        {"id": "root", "component": "Text", "text": "InlineOld"}
                    ],
                    "dataModel": {"inlineMarker": 42},
                    "metadata": {"extensions": {"source": "compiler"}},
                },
            }
        ]
    }
    result = await tool.run_async(
        args={"intent": "update", "target_surface_id": "s"},
        tool_context=_context(prior),
    )
    assert "a2ui_operations" in result, result
    assert all("createSurface" not in op for op in result["a2ui_operations"])
    prompt = (
        model.requests[0].config.system_instruction
        if inference_format == "express"
        else model.prompts[0]
    )
    assert "InlineOld" in prompt and "inlineMarker" in prompt
    if inference_format == "express":
        assert next(
            op["updateDataModel"]["value"]
            for op in result["a2ui_operations"]
            if "updateDataModel" in op
        ) == {"inlineMarker": 42}


async def test_v1_express_preserves_surface_extensions_in_final_and_activities():
    model = _ExpressLlm(
        model="scripted",
        scripts=[
            [
                '<a2ui>surface("s", extensions={source:"compiler"})\n'
                'root=Text("Hello")\n</a2ui>'
            ]
        ],
    )
    tool = get_a2ui_tool(
        {
            "model": model,
            "catalog": _catalog("1.0"),
            "inference_format": "express",
            "default_surface_id": "s",
        }
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={}, tool_context=_context())
    assert "a2ui_operations" in result, result
    expected = {"extensions": {"source": "compiler"}}
    assert result["a2ui_operations"][0]["createSurface"].get("metadata") == expected
    for event in tool.event_queue._queue:
        if event.type == "ACTIVITY_SNAPSHOT" and "a2ui_operations" in event.content:
            assert (
                event.content["a2ui_operations"][0]["createSurface"].get("metadata")
                == expected
            )


@pytest.mark.parametrize("inference_format", FORMATS)
@pytest.mark.parametrize("version", [None, "", 1, "garbage", "1.1"])
async def test_invalid_version_in_unusable_catalog_cannot_fall_back(
    inference_format, version
):
    model = _model(inference_format)
    tool = get_a2ui_tool(
        {
            "model": model,
            "catalog": {"protocolVersion": version, "components": {}},
            "inference_format": inference_format,
        }
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={}, tool_context=_context())
    assert "protocol" in result.get("error", "").lower(), result
    assert not _calls(model)


@pytest.mark.parametrize("inference_format", FORMATS)
async def test_configured_catalog_id_is_used_without_a_client_catalog(
    inference_format,
):
    """#2869: with no client catalog, both formats fall back to the basic catalog
    and stamp the configured default_catalog_id, which must match the host
    renderer's registration."""
    host_id = "https://example.com/host/basic_catalog.json"
    model = _model(inference_format)
    tool = get_a2ui_tool(
        {
            "model": model,
            "default_catalog_id": host_id,
            "inference_format": inference_format,
            "default_surface_id": "s",
        }
    )
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={}, tool_context=_context())
    assert "a2ui_operations" in result, result
    assert result["a2ui_operations"][0]["createSurface"]["catalogId"] == host_id
