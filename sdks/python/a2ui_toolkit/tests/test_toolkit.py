"""Unit tests for ag_ui_a2ui_toolkit's pure helpers.

Mirrors the TypeScript ``a2ui-toolkit/src/__tests__/toolkit.test.ts`` suite
so both languages stay aligned on expected behavior.
"""

from __future__ import annotations

import json
import unittest

from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    BASIC_CATALOG_ID,
    DEFAULT_SURFACE_ID,
    RENDER_A2UI_TOOL_DEF,
    assemble_ops,
    build_a2ui_envelope,
    build_context_prompt,
    build_subagent_prompt,
    create_surface,
    find_prior_surface,
    prepare_a2ui_request,
    update_components,
    update_data_model,
    wrap_as_operations_envelope,
    wrap_error_envelope,
)


class TestConstants(unittest.TestCase):
    def test_operations_key(self):
        self.assertEqual(A2UI_OPERATIONS_KEY, "a2ui_operations")

    def test_basic_catalog_id(self):
        self.assertEqual(
            BASIC_CATALOG_ID,
            "https://a2ui.org/specification/v0_9/basic_catalog.json",
        )


class TestRenderToolDef(unittest.TestCase):
    def test_shape(self):
        self.assertEqual(RENDER_A2UI_TOOL_DEF["type"], "function")
        self.assertEqual(RENDER_A2UI_TOOL_DEF["function"]["name"], "render_a2ui")

    def test_required_fields(self):
        self.assertEqual(
            RENDER_A2UI_TOOL_DEF["function"]["parameters"]["required"],
            ["surfaceId", "components"],
        )

    def test_parameter_keys(self):
        self.assertEqual(
            list(RENDER_A2UI_TOOL_DEF["function"]["parameters"]["properties"].keys()),
            ["surfaceId", "components", "data"],
        )


class TestOpBuilders(unittest.TestCase):
    def test_create_surface(self):
        self.assertEqual(
            create_surface("s1", "c1"),
            {
                "version": "v0.9",
                "createSurface": {"surfaceId": "s1", "catalogId": "c1"},
            },
        )

    def test_update_components(self):
        comps = [{"id": "root", "component": "Row"}]
        self.assertEqual(
            update_components("s1", comps),
            {
                "version": "v0.9",
                "updateComponents": {"surfaceId": "s1", "components": comps},
            },
        )

    def test_update_data_model_defaults(self):
        self.assertEqual(
            update_data_model("s1", {"items": []}),
            {
                "version": "v0.9",
                "updateDataModel": {
                    "surfaceId": "s1",
                    "path": "/",
                    "value": {"items": []},
                },
            },
        )

    def test_update_data_model_custom_path(self):
        self.assertEqual(
            update_data_model("s1", "hello", "/title"),
            {
                "version": "v0.9",
                "updateDataModel": {
                    "surfaceId": "s1",
                    "path": "/title",
                    "value": "hello",
                },
            },
        )


class TestBuildContextPrompt(unittest.TestCase):
    def test_empty_state(self):
        self.assertEqual(build_context_prompt({}), "")

    def test_described_entry(self):
        prompt = build_context_prompt(
            {
                "ag-ui": {
                    "context": [
                        {"description": "Style guide", "value": "use cards"}
                    ],
                }
            }
        )
        self.assertIn("## Style guide", prompt)
        self.assertIn("use cards", prompt)

    def test_value_only_entry(self):
        prompt = build_context_prompt(
            {"ag-ui": {"context": [{"value": "free-form note"}]}}
        )
        self.assertIn("free-form note", prompt)
        self.assertNotIn("##", prompt)

    def test_catalog_section(self):
        prompt = build_context_prompt({"ag-ui": {"a2ui_schema": "<catalog json>"}})
        self.assertIn("## Available Components", prompt)
        self.assertIn("<catalog json>", prompt)

    def test_empty_entries_dropped(self):
        prompt = build_context_prompt({"ag-ui": {"context": [{}]}})
        self.assertEqual(prompt, "")


class _ToolMessage:
    """Minimal stand-in for langchain's ToolMessage (or similar) — exposes
    ``type`` and ``content`` as attributes so the role-detection path works."""

    def __init__(self, content: str, role: str = "tool"):
        self.type = role
        self.content = content


class TestFindPriorSurface(unittest.TestCase):
    @staticmethod
    def _tool(content):
        return _ToolMessage(json.dumps(content))

    def test_returns_none_when_missing(self):
        messages = [self._tool({A2UI_OPERATIONS_KEY: []})]
        self.assertIsNone(find_prior_surface(messages, "missing"))

    def test_reconstructs_state(self):
        messages = [
            self._tool(
                {
                    A2UI_OPERATIONS_KEY: [
                        create_surface("s1", "cat://x"),
                        update_components("s1", [{"id": "root", "component": "Row"}]),
                        update_data_model("s1", {"items": [1, 2]}),
                    ]
                }
            )
        ]
        prior = find_prior_surface(messages, "s1")
        self.assertEqual(prior["components"], [{"id": "root", "component": "Row"}])
        self.assertEqual(prior["data"], {"items": [1, 2]})
        self.assertEqual(prior["catalogId"], "cat://x")

    def test_prefers_latest(self):
        messages = [
            self._tool(
                {
                    A2UI_OPERATIONS_KEY: [
                        create_surface("s1", "old-cat"),
                        update_components("s1", [{"id": "root", "component": "Row"}]),
                    ]
                }
            ),
            self._tool(
                {
                    A2UI_OPERATIONS_KEY: [
                        update_components("s1", [{"id": "root", "component": "Column"}]),
                        update_data_model("s1", {"changed": True}),
                    ]
                }
            ),
        ]
        prior = find_prior_surface(messages, "s1")
        self.assertEqual(prior["components"], [{"id": "root", "component": "Column"}])
        self.assertEqual(prior["data"], {"changed": True})

    def test_ignores_non_tool(self):
        messages = [
            _ToolMessage("not a tool", role="assistant"),
            _ToolMessage("not json", role="tool"),
            self._tool({"unrelated": "payload"}),
        ]
        self.assertIsNone(find_prior_surface(messages, "s1"))

    def test_accepts_dict_style_messages(self):
        # Plain-dict messages (the shape LangChain produces after a JSON
        # round-trip) must be honored — the walker can't silently skip them.
        msg = {
            "type": "tool",
            "content": json.dumps(
                {
                    A2UI_OPERATIONS_KEY: [
                        create_surface("s1", "c"),
                        update_components(
                            "s1", [{"id": "root", "component": "Row"}]
                        ),
                    ]
                }
            ),
        }
        prior = find_prior_surface([msg], "s1")
        self.assertIsNotNone(prior)
        self.assertEqual(prior["catalogId"], "c")
        self.assertEqual(
            prior["components"], [{"id": "root", "component": "Row"}]
        )

    def test_within_message_last_op_wins(self):
        # One envelope emits multiple ops for the same surface. The renderer
        # applies them in order, so the surface ends at layout-b / {v:2} / cat-B.
        msg = self._tool(
            {
                A2UI_OPERATIONS_KEY: [
                    create_surface("s1", "cat-A"),
                    update_components("s1", [{"id": "root", "component": "Row"}]),
                    update_data_model("s1", {"v": 1}),
                    create_surface("s1", "cat-B"),
                    update_components(
                        "s1", [{"id": "root", "component": "Column"}]
                    ),
                    update_data_model("s1", {"v": 2}),
                ]
            }
        )
        prior = find_prior_surface([msg], "s1")
        self.assertEqual(
            prior,
            {
                "components": [{"id": "root", "component": "Column"}],
                "data": {"v": 2},
                "catalogId": "cat-B",
            },
        )

    def test_accumulates_fields_across_walk(self):
        # Turn 1: full create + components + initial data.
        # Turn 2: only updateDataModel.
        # The walker must surface the components + catalogId from turn 1 plus
        # the updated data from turn 2 — not blank components because the most
        # recent message happened to omit them.
        msg1 = self._tool(
            {
                A2UI_OPERATIONS_KEY: [
                    create_surface("s1", "cat://x"),
                    update_components("s1", [{"id": "root", "component": "Row"}]),
                    update_data_model("s1", {"items": [1]}),
                ]
            }
        )
        msg2 = self._tool(
            {A2UI_OPERATIONS_KEY: [update_data_model("s1", {"items": [1, 2, 3]})]}
        )
        prior = find_prior_surface([msg1, msg2], "s1")
        self.assertEqual(
            prior,
            {
                "components": [{"id": "root", "component": "Row"}],
                "data": {"items": [1, 2, 3]},
                "catalogId": "cat://x",
            },
        )

    def test_newest_delete_surface_returns_none(self):
        # Older message populated the surface; newer message deletes it.
        # The renderer no longer shows it, so find_prior_surface must NOT
        # resurrect the stale state from the older ops.
        msg1 = self._tool(
            {
                A2UI_OPERATIONS_KEY: [
                    create_surface("s1", "cat://x"),
                    update_components("s1", [{"id": "root", "component": "Row"}]),
                    update_data_model("s1", {"items": [1, 2]}),
                ]
            }
        )
        msg2 = self._tool(
            {
                A2UI_OPERATIONS_KEY: [
                    {"version": "v0.9", "deleteSurface": {"surfaceId": "s1"}}
                ]
            }
        )
        self.assertIsNone(find_prior_surface([msg1, msg2], "s1"))

    def test_older_delete_surface_overridden_by_newer_create(self):
        # Older message deleted the surface; newer message recreates it. The
        # newer state must be returned — the older delete is dead history.
        msg1 = self._tool(
            {
                A2UI_OPERATIONS_KEY: [
                    {"version": "v0.9", "deleteSurface": {"surfaceId": "s1"}}
                ]
            }
        )
        msg2 = self._tool(
            {
                A2UI_OPERATIONS_KEY: [
                    create_surface("s1", "cat://new"),
                    update_components(
                        "s1", [{"id": "root", "component": "Column"}]
                    ),
                    update_data_model("s1", {"items": [9]}),
                ]
            }
        )
        prior = find_prior_surface([msg1, msg2], "s1")
        self.assertEqual(
            prior,
            {
                "components": [{"id": "root", "component": "Column"}],
                "data": {"items": [9]},
                "catalogId": "cat://new",
            },
        )

    def test_intra_message_delete_then_create_returns_recreated(self):
        # Within one message, ops apply in order. Delete then create → surface
        # exists with recreated content at end of message.
        msg = self._tool(
            {
                A2UI_OPERATIONS_KEY: [
                    {"version": "v0.9", "deleteSurface": {"surfaceId": "s1"}},
                    create_surface("s1", "cat-recreated"),
                    update_components("s1", [{"id": "root", "component": "Row"}]),
                ]
            }
        )
        prior = find_prior_surface([msg], "s1")
        self.assertEqual(
            prior,
            {
                "components": [{"id": "root", "component": "Row"}],
                "data": None,
                "catalogId": "cat-recreated",
            },
        )

    def test_intra_message_create_then_delete_returns_none(self):
        # Within one message, the surface is created then deleted — end state
        # is deleted, regardless of older accumulated state in prior messages.
        msg1 = self._tool(
            {
                A2UI_OPERATIONS_KEY: [
                    create_surface("s1", "older-cat"),
                    update_components("s1", [{"id": "root", "component": "Row"}]),
                ]
            }
        )
        msg2 = self._tool(
            {
                A2UI_OPERATIONS_KEY: [
                    create_surface("s1", "transient"),
                    {"version": "v0.9", "deleteSurface": {"surfaceId": "s1"}},
                ]
            }
        )
        self.assertIsNone(find_prior_surface([msg1, msg2], "s1"))


class TestBuildSubagentPrompt(unittest.TestCase):
    def test_context_only(self):
        self.assertEqual(
            build_subagent_prompt(context_prompt="ctx"), "ctx"
        )

    def test_appends_composition_guide(self):
        prompt = build_subagent_prompt(
            context_prompt="ctx", composition_guide="guide"
        )
        self.assertEqual(prompt, "ctx\nguide")

    def test_edit_block(self):
        prompt = build_subagent_prompt(
            context_prompt="ctx",
            edit_context={
                "surfaceId": "s1",
                "prior": {
                    "components": [{"id": "root", "component": "Row"}],
                    "data": {"x": 1},
                },
                "changes": "make the title bigger",
            },
        )
        self.assertIn("Editing an existing surface", prompt)
        self.assertIn("'s1'", prompt)
        self.assertIn('"id": "root"', prompt)
        self.assertIn('"x": 1', prompt)
        self.assertIn("Requested changes", prompt)
        self.assertIn("make the title bigger", prompt)

    def test_omits_requested_changes_when_none(self):
        prompt = build_subagent_prompt(
            context_prompt="ctx",
            edit_context={"surfaceId": "s1", "prior": {"components": [], "data": None}},
        )
        self.assertNotIn("Requested changes", prompt)

    def test_empty_context_returns_empty(self):
        self.assertEqual(build_subagent_prompt(context_prompt=""), "")


class TestAssembleOps(unittest.TestCase):
    def test_create_intent_full_envelope(self):
        ops = assemble_ops(
            intent="create",
            surface_id="s1",
            catalog_id="cat://x",
            components=[{"id": "root", "component": "Row"}],
            data={"items": ["a"]},
        )
        self.assertEqual(len(ops), 3)
        self.assertIn("createSurface", ops[0])
        self.assertIn("updateComponents", ops[1])
        self.assertIn("updateDataModel", ops[2])

    def test_update_intent_skips_create_surface(self):
        ops = assemble_ops(
            intent="update",
            surface_id="s1",
            catalog_id="cat://x",
            components=[{"id": "root", "component": "Row"}],
            data={"items": ["a"]},
        )
        self.assertEqual(len(ops), 2)
        self.assertIn("updateComponents", ops[0])
        self.assertIn("updateDataModel", ops[1])

    def test_no_data_omits_data_model_op(self):
        ops = assemble_ops(
            intent="create",
            surface_id="s1",
            catalog_id="cat://x",
            components=[{"id": "root", "component": "Row"}],
        )
        self.assertEqual(len(ops), 2)
        self.assertIn("createSurface", ops[0])
        self.assertIn("updateComponents", ops[1])

    def test_empty_data_omits_data_model_op(self):
        ops = assemble_ops(
            intent="create",
            surface_id="s1",
            catalog_id="cat://x",
            components=[{"id": "root", "component": "Row"}],
            data={},
        )
        self.assertEqual(len(ops), 2)


class TestWrapAsOperationsEnvelope(unittest.TestCase):
    def test_serializes_under_key(self):
        ops = [create_surface("s1", "c")]
        envelope = json.loads(wrap_as_operations_envelope(ops))
        self.assertEqual(envelope, {A2UI_OPERATIONS_KEY: ops})

    def test_empty_ops(self):
        envelope = json.loads(wrap_as_operations_envelope([]))
        self.assertEqual(envelope, {A2UI_OPERATIONS_KEY: []})


class TestWrapErrorEnvelope(unittest.TestCase):
    def test_wraps_message(self):
        self.assertEqual(json.loads(wrap_error_envelope("boom")), {"error": "boom"})


def _prior_surface_message(surface_id: str):
    """A prior surface encoded the way it appears in conversation history."""

    class _Tool:
        def __init__(self, content: str):
            self.type = "tool"
            self.content = content

    return _Tool(
        wrap_as_operations_envelope(
            [
                create_surface(surface_id, "cat://x"),
                update_components(surface_id, [{"id": "root", "component": "Row"}]),
                update_data_model(surface_id, {"items": [1, 2]}),
            ]
        )
    )


class TestPrepareA2UIRequest(unittest.TestCase):
    def test_create_builds_prompt_no_prior(self):
        prep = prepare_a2ui_request(
            intent="create",
            target_surface_id=None,
            changes=None,
            messages=[],
            state={"ag-ui": {"context": [{"value": "ctx"}]}},
            composition_guide="guide",
        )
        self.assertIsNone(prep.get("error"))
        self.assertFalse(prep["is_update"])
        self.assertIsNone(prep["prior"])
        self.assertIn("ctx", prep["prompt"])
        self.assertIn("guide", prep["prompt"])

    def test_missing_intent_defaults_to_create(self):
        prep = prepare_a2ui_request(
            intent=None, target_surface_id=None, changes=None, messages=[], state={}
        )
        self.assertFalse(prep["is_update"])
        self.assertIsNone(prep.get("error"))

    def test_update_with_matching_prior(self):
        prep = prepare_a2ui_request(
            intent="update",
            target_surface_id="s1",
            changes="make it red",
            messages=[_prior_surface_message("s1")],
            state={},
        )
        self.assertIsNone(prep.get("error"))
        self.assertTrue(prep["is_update"])
        self.assertEqual(prep["prior"]["catalogId"], "cat://x")
        self.assertIn("Editing an existing surface", prep["prompt"])
        self.assertIn("make it red", prep["prompt"])

    def test_update_without_prior_errors(self):
        prep = prepare_a2ui_request(
            intent="update",
            target_surface_id="missing",
            changes=None,
            messages=[_prior_surface_message("s1")],
            state={},
        )
        self.assertEqual(prep["prompt"], "")
        self.assertIn("missing", prep["error"])
        self.assertIn("no prior render", prep["error"])


class TestBuildA2UIEnvelope(unittest.TestCase):
    def test_create_uses_configured_catalog_not_args(self):
        env = json.loads(
            build_a2ui_envelope(
                args={
                    "surfaceId": "from-args",
                    "components": [{"id": "root", "component": "Row"}],
                    "data": {"items": [1]},
                },
                is_update=False,
                target_surface_id=None,
                prior=None,
                default_catalog_id="cat://configured",
            )
        )
        ops = env[A2UI_OPERATIONS_KEY]
        self.assertEqual(
            ops[0]["createSurface"],
            {"surfaceId": "from-args", "catalogId": "cat://configured"},
        )
        self.assertEqual(
            ops[1]["updateComponents"]["components"],
            [{"id": "root", "component": "Row"}],
        )
        self.assertEqual(ops[2]["updateDataModel"]["value"], {"items": [1]})

    def test_create_falls_back_to_default_surface_id(self):
        env = json.loads(
            build_a2ui_envelope(
                args={"components": []},
                is_update=False,
                target_surface_id=None,
                prior=None,
            )
        )
        self.assertEqual(
            env[A2UI_OPERATIONS_KEY][0]["createSurface"]["surfaceId"],
            DEFAULT_SURFACE_ID,
        )

    def test_empty_string_defaults_fall_back_to_canonical(self):
        # Misconfigured host: both default_surface_id and default_catalog_id are
        # the empty string. Must NOT propagate "" into the emitted ops — the
        # renderer would surface as "Catalog not found: " / blank surface id.
        env = json.loads(
            build_a2ui_envelope(
                args={"components": [{"id": "root", "component": "Row"}]},
                is_update=False,
                target_surface_id=None,
                prior=None,
                default_surface_id="",
                default_catalog_id="",
            )
        )
        ops = env[A2UI_OPERATIONS_KEY]
        cs = next(op["createSurface"] for op in ops if "createSurface" in op)
        self.assertNotEqual(cs["surfaceId"], "")
        self.assertNotEqual(cs["catalogId"], "")
        self.assertEqual(cs["surfaceId"], DEFAULT_SURFACE_ID)
        self.assertEqual(cs["catalogId"], BASIC_CATALOG_ID)

    def test_non_string_arg_surface_id_falls_back_to_default(self):
        # The model is untrusted — `args["surfaceId"]` may come back as a
        # number, list, or null. Without narrowing, a non-string value
        # propagates into createSurface.surfaceId and the renderer crashes
        # (the renderer expects a string id). The toolkit must coerce to the
        # default in that case. Mirror of the TS narrow.
        for bad in [42, ["x"], None, {"a": 1}, True]:
            env = json.loads(
                build_a2ui_envelope(
                    args={"surfaceId": bad, "components": []},
                    is_update=False,
                    target_surface_id=None,
                    prior=None,
                )
            )
            cs = next(op["createSurface"] for op in env[A2UI_OPERATIONS_KEY] if "createSurface" in op)
            self.assertEqual(cs["surfaceId"], DEFAULT_SURFACE_ID)
            self.assertIsInstance(cs["surfaceId"], str)

    def test_update_with_empty_target_surface_id_falls_back_to_default(self):
        # Direct callers of build_a2ui_envelope (bypassing prepare_a2ui_request)
        # may pass `target_surface_id=""` on the update path. Empty strings
        # must NOT propagate into updateComponents.surfaceId.
        env = json.loads(
            build_a2ui_envelope(
                args={"components": [{"id": "root", "component": "Row"}]},
                is_update=True,
                target_surface_id="",
                prior={"components": [], "data": None, "catalogId": "cat://prior"},
            )
        )
        ops = env[A2UI_OPERATIONS_KEY]
        uc = next(op["updateComponents"] for op in ops if "updateComponents" in op)
        self.assertEqual(uc["surfaceId"], DEFAULT_SURFACE_ID)
        self.assertNotEqual(uc["surfaceId"], "")

    def test_update_skips_create_surface_and_keeps_target(self):
        env = json.loads(
            build_a2ui_envelope(
                args={
                    "surfaceId": "ignored",
                    "components": [{"id": "root", "component": "Column"}],
                },
                is_update=True,
                target_surface_id="s1",
                prior={"components": [], "data": None, "catalogId": "cat://prior"},
            )
        )
        ops = env[A2UI_OPERATIONS_KEY]
        self.assertFalse(any("createSurface" in o for o in ops))
        self.assertEqual(ops[0]["updateComponents"]["surfaceId"], "s1")


if __name__ == "__main__":
    unittest.main()
