import unittest
from pydantic import ValidationError

from ag_ui.core.types import Interrupt, ResumeEntry, RunAgentInput


class InterruptTest(unittest.TestCase):
    def test_required_fields_only(self):
        i = Interrupt(id="int-1", reason="tool_call")
        self.assertEqual(i.id, "int-1")
        self.assertEqual(i.reason, "tool_call")
        self.assertIsNone(i.message)
        self.assertIsNone(i.tool_call_id)

    def test_all_optional_fields(self):
        i = Interrupt(
            id="int-1",
            reason="input_required",
            message="Approve?",
            tool_call_id="tc-1",
            response_schema={"type": "object"},
            expires_at="2099-01-01T00:00:00Z",
            metadata={"foo": "bar"},
        )
        self.assertEqual(i.tool_call_id, "tc-1")
        self.assertEqual(i.response_schema, {"type": "object"})

    def test_alias_camel_case_on_serialization(self):
        i = Interrupt(id="int-1", reason="tool_call", tool_call_id="tc-1")
        dumped = i.model_dump(by_alias=True)
        self.assertIn("toolCallId", dumped)
        self.assertNotIn("tool_call_id", dumped)

    def test_parse_from_camel_case(self):
        i = Interrupt.model_validate({"id": "int-1", "reason": "tool_call", "toolCallId": "tc-1"})
        self.assertEqual(i.tool_call_id, "tc-1")

    def test_rejects_missing_id(self):
        with self.assertRaises(ValidationError):
            Interrupt(reason="tool_call")

    def test_rejects_missing_reason(self):
        with self.assertRaises(ValidationError):
            Interrupt(id="int-1")


class ResumeEntryTest(unittest.TestCase):
    def test_resolved_with_payload(self):
        r = ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True})
        self.assertEqual(r.status, "resolved")
        self.assertEqual(r.payload, {"approved": True})

    def test_cancelled_without_payload(self):
        r = ResumeEntry(interrupt_id="int-1", status="cancelled")
        self.assertEqual(r.status, "cancelled")
        self.assertIsNone(r.payload)

    def test_rejects_unknown_status(self):
        with self.assertRaises(ValidationError):
            ResumeEntry(interrupt_id="int-1", status="denied")

    def test_rejects_missing_interrupt_id(self):
        with self.assertRaises(ValidationError):
            ResumeEntry(status="resolved")

    def test_alias_camel_case_on_serialization(self):
        r = ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True})
        dumped = r.model_dump(by_alias=True)
        self.assertIn("interruptId", dumped)
        self.assertNotIn("interrupt_id", dumped)

    def test_parse_from_camel_case(self):
        r = ResumeEntry.model_validate({"interruptId": "int-1", "status": "cancelled"})
        self.assertEqual(r.interrupt_id, "int-1")
        self.assertEqual(r.status, "cancelled")


class RunAgentInputResumeTest(unittest.TestCase):
    def _base_input(self, **overrides):
        base = dict(
            thread_id="t-1",
            run_id="r-1",
            state={},
            messages=[],
            tools=[],
            context=[],
            forwarded_props={},
        )
        base.update(overrides)
        return base

    def test_without_resume(self):
        i = RunAgentInput(**self._base_input())
        self.assertIsNone(i.resume)

    def test_with_resume(self):
        i = RunAgentInput(
            **self._base_input(
                resume=[
                    ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True}),
                    ResumeEntry(interrupt_id="int-2", status="cancelled"),
                ]
            )
        )
        self.assertEqual(len(i.resume), 2)
        self.assertEqual(i.resume[0].status, "resolved")


if __name__ == "__main__":
    unittest.main()
