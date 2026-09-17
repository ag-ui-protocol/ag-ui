"""
The pre-1.0 whole-field null: still accepted, no longer silent.

A peer that writes ``"rawEvent": null`` instead of leaving the key out is
speaking the shape AG-UI retired for 1.0. Python has always read it as absent —
a tolerance recorded until now only in a test comment — and TypeScript's
``CompatibilityBoundary`` converts the same shapes while saying so once per
occurrence. These tests hold Python to the same announcement, under the same
rows of the repo-root DEPRECATIONS.md.

The boundary the announcement draws matters as much as the announcement: a
``null`` that is a VALUE — a required payload, a metadata entry, an operand of a
JSON Patch ``add`` — is data the protocol asks for, and warning about it would
teach callers to ignore the warning.
"""

import json
import os
import unittest
import warnings

from ag_ui.core import (
    CustomEvent,
    RunAgentInput,
    RunFinishedEvent,
    RunStartedEvent,
    StateDeltaEvent,
    SubagentFinishedEvent,
    TextMessageEndEvent,
    Tool,
    UserMessage,
)

SHIM = "[ag-ui][compat] Converting deprecated"


def messages_of(warning_list):
    return [str(entry.message) for entry in warning_list]


class DeprecatedOptionalNullsAreAnnounced(unittest.TestCase):
    """Every field DEPRECATIONS.md lists, read from the wire."""

    def assert_announces(self, model, document, expected):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            model.model_validate(document)
        messages = messages_of(caught)
        self.assertTrue(
            any(f"{SHIM} {expected}: null to an absent field." in message for message in messages),
            f"expected a shim warning naming {expected}, got {messages}",
        )
        self.assertTrue(
            all("DEPRECATIONS.md" in message for message in messages if SHIM in message)
        )

    def test_raw_event_null(self):
        self.assert_announces(
            TextMessageEndEvent,
            {"type": "TEXT_MESSAGE_END", "messageId": "m", "rawEvent": None},
            "TextMessageEndEvent.rawEvent",
        )

    def test_run_finished_result_null(self):
        self.assert_announces(
            RunFinishedEvent,
            {"type": "RUN_FINISHED", "threadId": "t", "runId": "r", "result": None},
            "RunFinishedEvent.result",
        )

    def test_subagent_finished_result_null(self):
        self.assert_announces(
            SubagentFinishedEvent,
            {"type": "SUBAGENT_FINISHED", "subagentRunId": "s", "result": None},
            "SubagentFinishedEvent.result",
        )

    def test_resume_payload_null(self):
        self.assert_announces(
            RunAgentInput,
            {
                "threadId": "t",
                "runId": "r",
                "messages": [],
                "resume": [{"interruptId": "i", "status": "resolved", "payload": None}],
            },
            "ResumeEntry.payload",
        )

    def test_media_part_metadata_null(self):
        self.assert_announces(
            UserMessage,
            {
                "id": "m",
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "url", "value": "https://x/y.png"},
                        "metadata": None,
                    }
                ],
            },
            "ImagePart.metadata",
        )

    def test_tool_parameters_null(self):
        self.assert_announces(
            Tool,
            {"name": "n", "description": "d", "parameters": None},
            "Tool.parameters",
        )

    def test_run_agent_input_state_null(self):
        self.assert_announces(
            RunAgentInput,
            {"threadId": "t", "runId": "r", "messages": [], "state": None},
            "RunAgentInput.state",
        )

    def test_run_agent_input_forwarded_props_null(self):
        self.assert_announces(
            RunAgentInput,
            {"threadId": "t", "runId": "r", "messages": [], "forwardedProps": None},
            "RunAgentInput.forwardedProps",
        )

    def test_nested_input_inside_run_started(self):
        # The echo a producer puts on RUN_STARTED is the same document, reached
        # one level down: the announcement has to survive the nesting.
        self.assert_announces(
            RunStartedEvent,
            {
                "type": "RUN_STARTED",
                "threadId": "t",
                "runId": "r",
                "input": {"threadId": "t", "runId": "r", "messages": [], "state": None},
            },
            "RunAgentInput.state",
        )

    def test_the_conversion_still_happens(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            event = TextMessageEndEvent.model_validate(
                {"type": "TEXT_MESSAGE_END", "messageId": "m", "rawEvent": None}
            )
        self.assertIsNone(event.raw_event)
        self.assertNotIn("rawEvent", json.loads(event.model_dump_json(by_alias=True)))


class NullsThatAreValuesAreSilent(unittest.TestCase):
    def assert_silent(self, model, document):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            model.model_validate(document)
        self.assertEqual(
            [message for message in messages_of(caught) if SHIM in message], []
        )

    def test_absent_field_is_silent(self):
        self.assert_silent(TextMessageEndEvent, {"type": "TEXT_MESSAGE_END", "messageId": "m"})

    def test_metadata_key_holding_null_is_silent(self):
        # metadata is open by key and a null under one is data, which
        # DEPRECATIONS.md says will never join the list.
        self.assert_silent(
            TextMessageEndEvent,
            {"type": "TEXT_MESSAGE_END", "messageId": "m", "metadata": {"k": None}},
        )

    def test_json_patch_add_of_null_is_silent(self):
        self.assert_silent(
            StateDeltaEvent,
            {"type": "STATE_DELTA", "delta": [{"op": "add", "path": "/a", "value": None}]},
        )

    def test_required_payload_null_is_silent(self):
        # CUSTOM.value is required and null is one of its legal values.
        self.assert_silent(CustomEvent, {"type": "CUSTOM", "name": "n", "value": None})

    def test_a_field_left_out_is_silent_however_it_is_built(self):
        # The recommended shape, from Python: omit the field rather than pass
        # None. Nothing to convert, so nothing to announce.
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            TextMessageEndEvent(message_id="m")
            RunStartedEvent(
                thread_id="t",
                run_id="r",
                input={"threadId": "t", "runId": "r", "messages": []},
            )
        self.assertEqual(
            [message for message in messages_of(caught) if SHIM in message], []
        )


class TheCallerCannotBeToldApart(unittest.TestCase):
    """
    The one boundary this SDK could not draw, pinned so it is a decision rather
    than an oversight.

    Pydantic routes a model carrying any custom ``__init__`` through that
    ``__init__`` for every validation — ``model_validate`` and every
    ``TypeAdapter`` included — so a "suppress while the constructor runs" flag
    suppresses the wire path with it. Rather than lose the wire path, the
    announcement names both callers; the two say the same thing, and the same
    fix (leave the field out) answers both.
    """

    def test_explicit_none_from_python_is_announced_too(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            TextMessageEndEvent(message_id="m", raw_event=None)
        self.assertTrue(
            any(
                f"{SHIM} TextMessageEndEvent.raw_event: null" in message
                for message in messages_of(caught)
            )
        )

    def test_pydantic_routes_validation_through_a_custom_init(self):
        # The measurement the decision rests on: if this ever stops holding, the
        # constructor can be told apart again and the boundary can be drawn.
        import pydantic

        seen = []

        class Probe(pydantic.BaseModel):
            def __init__(self, **data):
                seen.append("init")
                super().__init__(**data)

        class Concrete(Probe):
            x: int = 0

        Concrete.model_validate({"x": 1})
        self.assertEqual(seen, ["init"])


class TheAnnouncementCanBeSilenced(unittest.TestCase):
    def test_suppress_transformation_warnings(self):
        os.environ["SUPPRESS_TRANSFORMATION_WARNINGS"] = "true"
        try:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                event = TextMessageEndEvent.model_validate(
                    {"type": "TEXT_MESSAGE_END", "messageId": "m", "rawEvent": None}
                )
            self.assertEqual(
                [message for message in messages_of(caught) if SHIM in message], []
            )
            self.assertIsNone(event.raw_event)
        finally:
            del os.environ["SUPPRESS_TRANSFORMATION_WARNINGS"]


if __name__ == "__main__":
    unittest.main()
