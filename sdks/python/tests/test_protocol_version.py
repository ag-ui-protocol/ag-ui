"""
The protocol version constant, and the declaration a producer sends.

``PROTOCOL_VERSION`` is generated from the schema's ``$id`` and re-exported
from ``ag_ui.core``. It is the one version this SDK reports, and the same
string the TypeScript SDK reports, because the two speak to each other.
"""

import json
import re
import unittest
from pathlib import Path

import ag_ui.core as core
from ag_ui.core import (
    PROTOCOL_VERSION,
    RunAgentInput,
    RunStartedEvent,
)
from ag_ui._generated.version import PROTOCOL_VERSION as GENERATED_PROTOCOL_VERSION

# sdks/python/tests/test_protocol_version.py -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
TS_VERSION = (
    REPO_ROOT / "sdks" / "typescript" / "packages" / "core" / "src" / "generated" / "version.ts"
)


class TestProtocolVersionConstant(unittest.TestCase):
    """The constant is public, generated, and wire-legal."""

    def test_it_is_exported_from_ag_ui_core(self):
        self.assertIn("PROTOCOL_VERSION", core.__all__)

    def test_it_is_the_generated_schema_revision(self):
        # Re-exported, not redefined: ag_ui.core must hand back the generated
        # constant itself, so a regeneration cannot leave the two disagreeing.
        self.assertEqual(PROTOCOL_VERSION, GENERATED_PROTOCOL_VERSION)

    def test_it_matches_the_published_grammar(self):
        # versioning.mdx publishes exactly two numeric components. A consumer
        # comparing declarations rejects anything else as uninterpretable, so a
        # value this SDK sends has to parse on the other side. This is what a
        # frozen version buys: a schema revision that is legal on the wire.
        self.assertRegex(PROTOCOL_VERSION, r"^\d+\.\d+$")


class TestConstantMatchesTypeScript(unittest.TestCase):
    """The Python and TypeScript SDKs must report the same protocol version."""

    def test_typescript_generates_the_same_protocol_version(self):
        if not TS_VERSION.exists():
            self.skipTest(f"TypeScript core sources not present at {TS_VERSION}")
        source = TS_VERSION.read_text(encoding="utf-8")
        match = re.search(
            r"""export const PROTOCOL_VERSION\s*=\s*["']([^"']+)["']""", source
        )
        self.assertIsNotNone(
            match,
            f"PROTOCOL_VERSION is no longer declared in {TS_VERSION}; "
            "the cross-SDK check has gone vacuous",
        )
        self.assertEqual(match.group(1), PROTOCOL_VERSION)


class TestProtocolVersionOnTheWire(unittest.TestCase):
    """The declaration a producer sends, and the one a client sends back."""

    def test_run_started_serializes_the_declaration_as_protocol_version(self):
        event = RunStartedEvent(
            thread_id="thread-1",
            run_id="run-1",
            protocol_version=PROTOCOL_VERSION,
        )
        payload = json.loads(event.model_dump_json(by_alias=True))
        self.assertEqual(payload["protocolVersion"], PROTOCOL_VERSION)

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
            protocol_version=PROTOCOL_VERSION,
        )
        payload = json.loads(run_input.model_dump_json(by_alias=True))
        self.assertEqual(payload["protocolVersion"], PROTOCOL_VERSION)

    def test_the_declaration_round_trips_through_the_wire_name(self):
        wire = {
            "type": "RUN_STARTED",
            "threadId": "thread-1",
            "runId": "run-1",
            "protocolVersion": PROTOCOL_VERSION,
        }
        event = RunStartedEvent.model_validate(wire)
        self.assertEqual(event.protocol_version, PROTOCOL_VERSION)


if __name__ == "__main__":
    unittest.main()
