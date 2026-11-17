"""Express activities replay independently while final updates remain deltas."""

import asyncio
import copy

import pytest
from a2ui.core import Catalog
from a2ui.core.basic_catalog import BasicCatalog
from a2ui.utils import validate_payload

from ag_ui_adk import get_a2ui_tool

from .test_a2ui_google_sdk import _ExpressLlm
from .test_a2ui_protocol_versions import _context


def _paints(queue):
    return [
        event
        for event in queue._queue
        if event.type == "ACTIVITY_SNAPSHOT" and "a2ui_operations" in event.content
    ]


def _run_context(call_id, *envelopes):
    context = _context(*envelopes)
    context.function_call_id = call_id
    return context


@pytest.mark.parametrize("version", ["v0.9", "1.0"])
async def test_express_update_activity_is_independent_from_the_create_activity(version):
    catalog = BasicCatalog(version).to_json()
    model = _ExpressLlm(
        model="scripted",
        scripts=[
            ['<a2ui>$/message="Before"\nroot=Text($/message)</a2ui>'],
            [
                '<a2ui>surface("s", update=true)\n$/message="After"\n',
                "root=Text($/message)</a2ui>",
            ],
        ],
    )
    shared = get_a2ui_tool(
        {
            "model": model,
            "catalog": catalog,
            "default_surface_id": "s",
            "inference_format": "express",
        }
    )
    create_queue = asyncio.Queue()
    created = await shared.for_run(create_queue).run_async(
        args={}, tool_context=_run_context("create-call")
    )
    assert "a2ui_operations" in created, created
    original_create = copy.deepcopy(created)
    original_snapshots = copy.deepcopy(
        [event.content for event in _paints(create_queue)]
    )
    update_queue = asyncio.Queue()
    updated = await shared.for_run(update_queue).run_async(
        args={"intent": "update", "target_surface_id": "s"},
        tool_context=_run_context("update-call", created),
    )
    assert "a2ui_operations" in updated, updated
    # The canonical result addresses the already-existing protocol surface.
    assert all("createSurface" not in op for op in updated["a2ui_operations"])
    validate_payload(
        [Catalog.from_json(catalog)],
        created["a2ui_operations"] + updated["a2ui_operations"],
    )
    snapshots = _paints(update_queue)
    assert snapshots
    assert {event.message_id for event in snapshots} == {"a2ui-surface-update-call"}
    assert {event.message_id for event in _paints(create_queue)} == {
        "a2ui-surface-create-call"
    }
    for event in snapshots:
        # A new chat activity has no access to the previous activity's SDK state.
        operations = event.content["a2ui_operations"]
        assert operations[0].get("createSurface") == {
            "surfaceId": "s",
            "catalogId": catalog["catalogId"],
        }
        assert {op["version"] for op in operations} == {version}
        validate_payload([Catalog.from_json(catalog)], operations)
    final_snapshot = snapshots[-1].content["a2ui_operations"]
    assert final_snapshot[1:] == updated["a2ui_operations"]
    assert final_snapshot[-1]["updateDataModel"]["value"] == {"message": "After"}
    assert created == original_create
    assert [event.content for event in _paints(create_queue)] == original_snapshots


@pytest.mark.parametrize("version", ["v0.9", "1.0"])
async def test_express_update_with_missing_data_waits_for_valid_recovery(version):
    model = _ExpressLlm(
        model="scripted",
        scripts=[
            ['<a2ui>$/message="Before"\nroot=Text($/message)</a2ui>'],
            ['<a2ui>surface("s", update=true)\nroot=Text($/missing)</a2ui>'],
            [
                '<a2ui>surface("s", update=true)\n$/message="After"\n',
                "root=Text($/message)</a2ui>",
            ],
        ],
    )
    catalog = BasicCatalog(version).to_json()
    attempts = []
    counts_after_failed_attempt = []
    update_queue = asyncio.Queue()

    def record(attempt):
        attempts.append(attempt)
        if not attempt["ok"]:
            counts_after_failed_attempt.append(len(_paints(update_queue)))

    shared = get_a2ui_tool(
        {
            "model": model,
            "catalog": catalog,
            "default_surface_id": "s",
            "inference_format": "express",
            "on_a2ui_attempt": record,
        }
    )
    created = await shared.for_run(asyncio.Queue()).run_async(
        args={}, tool_context=_run_context("create-call")
    )
    attempts.clear()
    updated = await shared.for_run(update_queue).run_async(
        args={"intent": "update", "target_surface_id": "s"},
        tool_context=_run_context("update-call", created),
    )
    assert [attempt["ok"] for attempt in attempts] == [False, True]
    assert counts_after_failed_attempt == [0]
    assert "a2ui_operations" in updated, updated
    assert all("createSurface" not in op for op in updated["a2ui_operations"])
    assert _paints(update_queue)
    for event in _paints(update_queue):
        operations = event.content["a2ui_operations"]
        assert "createSurface" in operations[0]
        assert {op["version"] for op in operations} == {version}
        validate_payload([Catalog.from_json(catalog)], operations)
    assert len({event.message_id for event in update_queue._queue}) == 1


@pytest.mark.parametrize(
    "version,attributes",
    [
        ("v0.9", {"sendDataModel": True, "theme": {"primaryColor": "#123456"}}),
        (
            "1.0",
            {
                "sendDataModel": True,
                "metadata": {"extensions": {"tag": {"label": "keep"}}},
            },
        ),
    ],
)
async def test_express_update_activity_retains_current_creation_attributes(
    version, attributes
):
    from ag_ui_adk import compile_a2ui_express

    catalog = BasicCatalog(version).to_json()
    created = {
        "a2ui_operations": compile_a2ui_express(
            'root=Text("Before")', catalog=catalog, surface_id="s"
        )
    }
    created["a2ui_operations"][0]["createSurface"].update(copy.deepcopy(attributes))
    validate_payload([Catalog.from_json(catalog)], created["a2ui_operations"])
    original = copy.deepcopy(created)
    shared = get_a2ui_tool(
        {
            "model": _ExpressLlm(
                model="scripted",
                scripts=[
                    ['<a2ui>surface("s", update=true)\nroot=Text("After")</a2ui>']
                ],
            ),
            "catalog": catalog,
            "default_surface_id": "s",
            "inference_format": "express",
        }
    )
    history = [created]
    prior_paints = []
    for turn in range(2):
        queue = asyncio.Queue()
        context = _run_context(f"update-{turn}", *history)
        original_events = copy.deepcopy(context.session.events)
        updated = await shared.for_run(queue).run_async(
            args={"intent": "update", "target_surface_id": "s"},
            tool_context=context,
        )
        assert "a2ui_operations" in updated, updated
        assert all("createSurface" not in op for op in updated["a2ui_operations"])
        snapshots = _paints(queue)
        assert snapshots
        for event in snapshots:
            operations = event.content["a2ui_operations"]
            assert operations[0]["createSurface"] == {
                "surfaceId": "s",
                "catalogId": catalog["catalogId"],
                **attributes,
            }
            validate_payload([Catalog.from_json(catalog)], operations)
        assert context.session.events == original_events
        for event, original_content in prior_paints:
            assert event.content == original_content
        prior_paints += [(event, copy.deepcopy(event.content)) for event in snapshots]
        history.append(updated)
    assert created == original


@pytest.mark.parametrize("version", ["v0.9", "1.0"])
async def test_express_recreated_surface_does_not_inherit_old_creation_attributes(
    version,
):
    from ag_ui_adk import compile_a2ui_express

    catalog = BasicCatalog(version).to_json()
    old = {
        "a2ui_operations": compile_a2ui_express(
            'root=Text("Old")', catalog=catalog, surface_id="s"
        )
    }
    old["a2ui_operations"][0]["createSurface"]["sendDataModel"] = True
    if version == "1.0":
        old["a2ui_operations"][0]["createSurface"]["metadata"] = {
            "extensions": {"old": True}
        }
    else:
        old["a2ui_operations"][0]["createSurface"]["theme"] = {
            "primaryColor": "#123456"
        }
    deleted = {
        "a2ui_operations": [{"version": version, "deleteSurface": {"surfaceId": "s"}}]
    }
    recreated = {
        "a2ui_operations": compile_a2ui_express(
            'root=Text("New")', catalog=catalog, surface_id="s"
        )
    }
    queue = asyncio.Queue()
    tool = get_a2ui_tool(
        {
            "model": _ExpressLlm(
                model="scripted",
                scripts=[
                    ['<a2ui>surface("s", update=true)\nroot=Text("After")</a2ui>']
                ],
            ),
            "catalog": catalog,
            "default_surface_id": "s",
            "inference_format": "express",
        }
    ).for_run(queue)
    result = await tool.run_async(
        args={"intent": "update", "target_surface_id": "s"},
        tool_context=_run_context("update-current", old, deleted, recreated),
    )
    assert "a2ui_operations" in result, result
    assert _paints(queue)
    for event in _paints(queue):
        operations = event.content["a2ui_operations"]
        assert operations[0]["createSurface"] == {
            "surfaceId": "s",
            "catalogId": catalog["catalogId"],
        }
        validate_payload([Catalog.from_json(catalog)], operations)
