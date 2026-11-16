"""Native 1.0 bindings, schema recovery, and version-specific defaults."""

import asyncio
import copy

import pytest
from a2ui.core import Catalog
from a2ui.core.basic_catalog import BasicCatalog
from a2ui.utils import validate_payload

from ag_ui_adk import get_a2ui_tool

from .test_a2ui_google_sdk import _ExpressLlm, _RenderLlm
from .test_a2ui_protocol_versions import _context


def _tool(model, **kwargs):
    tool = get_a2ui_tool(
        {"model": model, "catalog": BasicCatalog("1.0").to_json(), **kwargs}
    )
    tool.event_queue = asyncio.Queue()
    return tool


@pytest.mark.parametrize("inference_format", ["direct_json", "express"])
async def test_native_v1_defaults_use_binding_directives(inference_format):
    model = (
        _RenderLlm(
            model="scripted",
            args={"components": [{"id": "root", "component": "Text", "text": "Hi"}]},
        )
        if inference_format == "direct_json"
        else _ExpressLlm(model="scripted", scripts=[['<a2ui>root = Text("Hi")</a2ui>']])
    )
    tool = _tool(model, inference_format=inference_format)
    result = await tool.run_async(args={}, tool_context=_context())
    assert "a2ui_operations" in result
    prompt = (
        model.prompts[0]
        if inference_format == "direct_json"
        else model.requests[0].config.system_instruction
    )
    # Both default generation and design prose must agree with the SDK schema.
    assert '"value": { "path":' not in prompt
    assert '"value": { "@path":' in prompt
    if inference_format == "direct_json":
        assert "@call" in prompt
        assert 'You MUST use { "path":' not in prompt


@pytest.mark.parametrize("inference_format", ["direct_json", "express"])
async def test_native_v1_unresolved_bindings_retry_without_painting(inference_format):
    attempts = []
    model = (
        _RenderLlm(
            model="scripted",
            args={
                "components": [
                    {"id": "root", "component": "Text", "text": {"@path": "/missing"}}
                ],
                "data": {},
            },
        )
        if inference_format == "direct_json"
        else _ExpressLlm(
            model="scripted", scripts=[["<a2ui>root = Text($/missing)</a2ui>"]]
        )
    )
    tool = _tool(
        model,
        inference_format=inference_format,
        recovery={"maxAttempts": 2},
        on_a2ui_attempt=attempts.append,
    )
    result = await tool.run_async(args={}, tool_context=_context())
    assert result.get("code") == "a2ui_recovery_exhausted", result
    assert len(attempts) == 2
    assert all(not attempt["ok"] for attempt in attempts)
    assert all(
        any(error["code"] == "unresolved_binding" for error in attempt["errors"])
        for attempt in attempts
    )
    assert not any(
        event.type == "ACTIVITY_SNAPSHOT" and "a2ui_operations" in event.content
        for event in tool.event_queue._queue
    )


async def test_native_v1_schema_errors_enter_recovery():
    attempts = []
    model = _RenderLlm(
        model="scripted",
        args={
            "components": [
                {"id": "root", "component": "Text", "text": {"path": "/name"}}
            ],
            "data": {"name": "Ada"},
        },
    )
    tool = _tool(model, recovery={"maxAttempts": 2}, on_a2ui_attempt=attempts.append)
    result = await tool.run_async(args={}, tool_context=_context())
    assert result.get("code") == "a2ui_recovery_exhausted", result
    assert len(model.prompts) == 2
    assert "Previous attempt was invalid" in model.prompts[1]
    assert "not valid" in model.prompts[1]
    assert [attempt["attempt"] for attempt in attempts] == [1, 2]


async def test_native_v1_literal_path_object_is_not_a_binding():
    catalog = BasicCatalog("1.0").to_json()
    components = [
        {
            "id": "root",
            "component": "Button",
            "child": "label",
            "action": {
                "event": {
                    "name": "submit",
                    "context": {"literal": {"path": "/not-a-binding"}},
                }
            },
        },
        {"id": "label", "component": "Text", "text": {"@path": "/name"}},
    ]
    model = _RenderLlm(
        model="scripted", args={"components": components, "data": {"name": "Ada"}}
    )
    tool = _tool(model)
    result = await tool.run_async(args={}, tool_context=_context())
    assert "a2ui_operations" in result, result
    validate_payload([Catalog.from_json(catalog)], result["a2ui_operations"])


async def test_native_v1_custom_guidelines_remain_unchanged():
    guidelines = {
        "generation_guidelines": "custom generation {path}",
        "design_guidelines": "custom design {path}",
    }
    original = copy.deepcopy(guidelines)
    model = _RenderLlm(
        model="scripted",
        args={"components": [{"id": "root", "component": "Text", "text": "Hi"}]},
    )
    result = await _tool(model, guidelines=guidelines).run_async(
        args={}, tool_context=_context()
    )
    assert "a2ui_operations" in result
    assert all(value in model.prompts[0] for value in guidelines.values())
    assert guidelines == original


@pytest.mark.parametrize("inference_format", ["direct_json", "express"])
async def test_native_v1_recovers_to_initialized_binding(inference_format):
    class RetryingRenderLlm(_RenderLlm):
        async def generate_content_async(self, llm_request, stream=False):
            self.args = {
                "components": [
                    {"id": "root", "component": "Text", "text": {"@path": "/name"}}
                ],
                "data": {} if not self.prompts else {"name": "Ada"},
            }
            async for response in super().generate_content_async(llm_request, stream):
                yield response

    model = (
        RetryingRenderLlm(model="scripted")
        if inference_format == "direct_json"
        else _ExpressLlm(
            model="scripted",
            scripts=[
                ["<a2ui>root = Text($/name)</a2ui>"],
                ['<a2ui>$/name = "Ada"\nroot = Text($/name)</a2ui>'],
            ],
        )
    )
    attempts = []
    tool = _tool(
        model, inference_format=inference_format, on_a2ui_attempt=attempts.append
    )
    result = await tool.run_async(args={}, tool_context=_context())
    assert "a2ui_operations" in result, result
    assert [attempt["ok"] for attempt in attempts] == [False, True]
    assert all(attempt["inference_format"] == inference_format for attempt in attempts)
    assert result["a2ui_operations"][-1]["updateDataModel"]["value"] == {"name": "Ada"}
    for event in tool.event_queue._queue:
        if event.type == "ACTIVITY_SNAPSHOT" and "a2ui_operations" in event.content:
            assert event.content["a2ui_operations"][-1]["updateDataModel"]["value"] == {
                "name": "Ada"
            }


@pytest.mark.parametrize("error", [RuntimeError("transport"), asyncio.CancelledError()])
def test_v1_recovery_propagates_transport_and_cancellation(error):
    from ag_ui_adk.a2ui_protocol import run_v1_generation_with_recovery

    attempts = []

    def invoke(prompt, attempt):
        raise error

    with pytest.raises(type(error)):
        run_v1_generation_with_recovery(
            base_prompt="generate",
            invoke_subagent=invoke,
            build_envelope=lambda args: "unused",
            on_attempt=attempts.append,
        )
    assert attempts == []


def test_v1_recovery_preserves_missing_call_and_compilation_error_contract():
    from ag_ui_a2ui_toolkit import A2UIGenerationError

    from ag_ui_adk.a2ui_protocol import run_v1_generation_with_recovery

    attempts = []
    diagnostic = {
        "code": "express_compilation_error",
        "path": "express",
        "message": "bad syntax",
    }

    def invoke(prompt, attempt):
        if attempt == 1:
            raise A2UIGenerationError([diagnostic])
        assert "Previous attempt was invalid" in prompt
        if attempt == 2:
            return None
        return {"components": [{"id": "root", "component": "Text", "text": "Hi"}]}

    result = run_v1_generation_with_recovery(
        base_prompt="generate",
        invoke_subagent=invoke,
        build_envelope=lambda args: "success",
        on_attempt=attempts.append,
    )
    assert result["envelope"] == "success"
    assert [attempt["ok"] for attempt in attempts] == [False, False, True]
    assert attempts[0]["errors"] == [diagnostic]
    assert attempts[1]["errors"][0]["message"] == "Sub-agent did not call render_a2ui"


def test_v1_guidelines_preserve_explicit_suppression():
    from ag_ui_adk.a2ui_protocol import v1_guidelines

    assert v1_guidelines(
        {"generation_guidelines": "", "design_guidelines": ""}, direct_json=True
    ) == {"generation_guidelines": "", "design_guidelines": ""}


@pytest.mark.parametrize(
    "path,data",
    [
        ("/a~1b/~0key", {"a/b": {"~key": "Ada"}}),
        ("/names/0", {"names": ["Ada"]}),
        ("name", {}),
    ],
)
def test_v1_binding_resolution_handles_pointer_escapes_arrays_and_relative_paths(
    path, data
):
    from ag_ui_adk.a2ui_protocol import validate_v1_components

    result = validate_v1_components(
        components=[{"id": "root", "component": "Text", "text": {"@path": path}}],
        data=data,
        catalog=BasicCatalog("1.0").to_json(),
    )
    assert result["valid"], result


@pytest.mark.parametrize(
    "path,data,valid",
    [
        ("/items", {}, False),
        ("/items", {"items": []}, True),
        ("/items", {"items": [{"name": "Ada"}]}, True),
        ("/groups/0/items", {"groups": [{"items": []}]}, True),
        ("/a~1b/~0items", {"a/b": {"~items": []}}, True),
        ("items", {}, True),
    ],
)
def test_v1_template_paths_resolve_without_changing_directive_syntax(path, data, valid):
    from ag_ui_adk.a2ui_protocol import validate_v1_components

    components = [
        {
            "id": "root",
            "component": "List",
            "children": {"componentId": "item", "path": path},
        },
        {"id": "item", "component": "Text", "text": "Item"},
    ]
    result = validate_v1_components(
        components=components, data=data, catalog=BasicCatalog("1.0").to_json()
    )
    assert result["valid"] is valid, result
    if not valid:
        assert result["errors"] == [
            {
                "code": "unresolved_binding",
                "path": "components[0].children",
                "message": f"Binding path '{path}' does not resolve in the data model",
            }
        ]
    assert components[0]["children"] == {"componentId": "item", "path": path}


@pytest.mark.parametrize("inference_format", ["direct_json", "express"])
async def test_v1_missing_template_data_retries_then_accepts_initialized_items(
    inference_format,
):
    class RetryingListLlm(_RenderLlm):
        async def generate_content_async(self, llm_request, stream=False):
            self.args = {
                "components": [
                    {
                        "id": "root",
                        "component": "List",
                        "children": {"componentId": "item", "path": "/items"},
                    },
                    {"id": "item", "component": "Text", "text": "Item"},
                ],
                "data": {} if not self.prompts else {"items": [{"name": "Ada"}]},
            }
            async for response in super().generate_content_async(llm_request, stream):
                yield response

    missing = 'root=List({componentId:"item",path:"/items"})\nitem=Text("Item")'
    model = (
        RetryingListLlm(model="scripted")
        if inference_format == "direct_json"
        else _ExpressLlm(
            model="scripted",
            scripts=[
                [f"<a2ui>{missing}</a2ui>"],
                ['<a2ui>$/items=[{name:"Ada"}]\n', missing, "</a2ui>"],
            ],
        )
    )
    attempts = []
    tool = _tool(
        model, inference_format=inference_format, on_a2ui_attempt=attempts.append
    )
    result = await tool.run_async(args={}, tool_context=_context())
    assert [attempt["ok"] for attempt in attempts] == [False, True], attempts
    assert attempts[0]["errors"][0]["code"] == "unresolved_binding"
    assert "/items" in attempts[0]["errors"][0]["message"]
    prompt = (
        model.prompts[1]
        if inference_format == "direct_json"
        else model.requests[1].config.system_instruction
    )
    assert "Previous attempt was invalid" in prompt and "unresolved_binding" in prompt
    assert "a2ui_operations" in result, result
    assert result["a2ui_operations"][-1]["updateDataModel"]["value"] == {
        "items": [{"name": "Ada"}]
    }
    for event in tool.event_queue._queue:
        if event.type == "ACTIVITY_SNAPSHOT" and "a2ui_operations" in event.content:
            assert event.content["a2ui_operations"][-1]["updateDataModel"]["value"] == {
                "items": [{"name": "Ada"}]
            }
