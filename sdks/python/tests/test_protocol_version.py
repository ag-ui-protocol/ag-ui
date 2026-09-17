"""
The protocol version constants, and the declaration a producer sends.

Two constants are public and they are NOT the same thing:
``WIRE_PROTOCOL_VERSION`` is the protocol line this SDK speaks on the wire,
``PROTOCOL_VERSION`` is the spec revision the models were generated from.
Both are exported from ``ag_ui.core``; the first must equal TypeScript's
constant of the same name, because the two SDKs speak to each other.
"""

import json
import re
import unittest
from pathlib import Path

import ag_ui.core as core
from ag_ui.core import (
    PROTOCOL_VERSION,
    WIRE_PROTOCOL_VERSION,
    RunAgentInput,
    RunStartedEvent,
)
from ag_ui._generated.version import PROTOCOL_VERSION as GENERATED_PROTOCOL_VERSION

# sdks/python/tests/test_protocol_version.py -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
TS_AGENT = (
    REPO_ROOT / "sdks" / "typescript" / "packages" / "client" / "src" / "agent" / "agent.ts"
)


class TestProtocolVersionConstants(unittest.TestCase):
    """Both constants are importable from the package's public entry point."""

    def test_both_constants_are_exported_from_ag_ui_core(self):
        self.assertIn("WIRE_PROTOCOL_VERSION", core.__all__)
        self.assertIn("PROTOCOL_VERSION", core.__all__)

    def test_wire_protocol_version_is_the_1_0_line(self):
        self.assertEqual(WIRE_PROTOCOL_VERSION, "1.0")

    def test_wire_protocol_version_matches_the_published_grammar(self):
        # versioning.mdx publishes exactly two numeric components. A consumer
        # comparing declarations rejects anything else as uninterpretable, so a
        # value this SDK sends has to parse on the other side.
        self.assertRegex(WIRE_PROTOCOL_VERSION, r"^\d+\.\d+$")

    def test_protocol_version_is_the_generated_schema_revision(self):
        # Re-exported, not redefined: ag_ui.core must hand back the generated
        # constant itself, so a regeneration cannot leave the two disagreeing.
        self.assertEqual(PROTOCOL_VERSION, GENERATED_PROTOCOL_VERSION)

    def test_the_wire_constant_is_never_the_unusable_schema_revision(self):
        # The two constants collapse into one string at the 1.0 freeze, when
        # the schema $id moves to /spec/1.0/ and PROTOCOL_VERSION becomes
        # "1.0" too. Asserted as the invariant that survives that freeze
        # rather than as the literal "draft", so a regeneration of
        # ag_ui/_generated does not turn this into a false alarm: while the
        # revision is outside the published two-component grammar it is NOT a
        # legal declaration, so the wire constant must differ from it; once it
        # is inside the grammar the two are allowed to be the same string.
        if re.fullmatch(r"\d+\.\d+", PROTOCOL_VERSION) is None:
            self.assertNotEqual(
                WIRE_PROTOCOL_VERSION,
                PROTOCOL_VERSION,
                "the wire declaration must never be the schema revision while "
                "that revision is not wire-legal",
            )


class TestWireConstantMatchesTypeScript(unittest.TestCase):
    """The Python and TypeScript SDKs must declare the same protocol line."""

    def test_typescript_declares_the_same_wire_protocol_version(self):
        if not TS_AGENT.exists():
            self.skipTest(f"TypeScript client sources not present at {TS_AGENT}")
        source = TS_AGENT.read_text(encoding="utf-8")
        match = re.search(
            r"""export const WIRE_PROTOCOL_VERSION\s*=\s*["']([^"']+)["']""", source
        )
        self.assertIsNotNone(
            match,
            f"WIRE_PROTOCOL_VERSION is no longer declared in {TS_AGENT}; "
            "the cross-SDK check has gone vacuous",
        )
        self.assertEqual(match.group(1), WIRE_PROTOCOL_VERSION)


class TestProtocolVersionOnTheWire(unittest.TestCase):
    """The declaration a producer sends, and the one a client sends back."""

    def test_run_started_serializes_the_declaration_as_protocol_version(self):
        event = RunStartedEvent(
            thread_id="thread-1",
            run_id="run-1",
            protocol_version=WIRE_PROTOCOL_VERSION,
        )
        payload = json.loads(event.model_dump_json(by_alias=True))
        self.assertEqual(payload["protocolVersion"], "1.0")

    def test_run_started_omits_the_declaration_when_it_is_not_set(self):
        # Absent means "a producer from before the protocol carried a version".
        # The generated model defaults to None and nothing fills it in, which
        # is why every producer has to pass it explicitly.
        event = RunStartedEvent(thread_id="thread-1", run_id="run-1")
        payload = json.loads(event.model_dump_json(by_alias=True))
        self.assertNotIn("protocolVersion", payload)

    def test_run_agent_input_serializes_the_declaration(self):
        run_input = RunAgentInput(
            thread_id="thread-1",
            run_id="run-1",
            state=None,
            messages=[],
            tools=[],
            context=[],
            forwarded_props={},
            protocol_version=WIRE_PROTOCOL_VERSION,
        )
        payload = json.loads(run_input.model_dump_json(by_alias=True))
        self.assertEqual(payload["protocolVersion"], "1.0")

    def test_the_declaration_round_trips_through_the_wire_name(self):
        wire = {
            "type": "RUN_STARTED",
            "threadId": "thread-1",
            "runId": "run-1",
            "protocolVersion": WIRE_PROTOCOL_VERSION,
        }
        event = RunStartedEvent.model_validate(wire)
        self.assertEqual(event.protocol_version, WIRE_PROTOCOL_VERSION)


if __name__ == "__main__":
    unittest.main()
