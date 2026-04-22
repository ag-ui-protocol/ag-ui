import unittest
from pydantic import ValidationError

from ag_ui.core.events import EventType, RunFinishedEvent
from ag_ui.core.types import Interrupt


class RunFinishedEventTest(unittest.TestCase):
    def test_success_with_result(self):
        e = RunFinishedEvent(thread_id="t-1", run_id="r-1", outcome="success", result={"ok": True})
        self.assertEqual(e.outcome, "success")
        self.assertEqual(e.result, {"ok": True})
        self.assertIsNone(e.interrupts)

    def test_success_without_result(self):
        e = RunFinishedEvent(thread_id="t-1", run_id="r-1", outcome="success")
        self.assertEqual(e.outcome, "success")
        self.assertIsNone(e.result)

    def test_interrupt_with_interrupts(self):
        e = RunFinishedEvent(
            thread_id="t-1",
            run_id="r-1",
            outcome="interrupt",
            interrupts=[Interrupt(id="int-1", reason="tool_call")],
        )
        self.assertEqual(e.outcome, "interrupt")
        self.assertEqual(len(e.interrupts), 1)

    def test_interrupt_rejects_empty_interrupts(self):
        with self.assertRaises(ValidationError):
            RunFinishedEvent(thread_id="t-1", run_id="r-1", outcome="interrupt", interrupts=[])

    def test_interrupt_rejects_missing_interrupts(self):
        with self.assertRaises(ValidationError):
            RunFinishedEvent(thread_id="t-1", run_id="r-1", outcome="interrupt")

    def test_interrupt_rejects_result(self):
        with self.assertRaises(ValidationError):
            RunFinishedEvent(
                thread_id="t-1",
                run_id="r-1",
                outcome="interrupt",
                interrupts=[Interrupt(id="int-1", reason="tool_call")],
                result={"ok": True},
            )

    def test_success_rejects_interrupts(self):
        with self.assertRaises(ValidationError):
            RunFinishedEvent(
                thread_id="t-1",
                run_id="r-1",
                outcome="success",
                interrupts=[Interrupt(id="int-1", reason="tool_call")],
            )

    def test_outcome_is_required(self):
        with self.assertRaises(ValidationError):
            RunFinishedEvent(thread_id="t-1", run_id="r-1")

    def test_camel_case_serialization(self):
        e = RunFinishedEvent(
            thread_id="t-1",
            run_id="r-1",
            outcome="interrupt",
            interrupts=[Interrupt(id="int-1", reason="tool_call", tool_call_id="tc-1")],
        )
        dumped = e.model_dump(by_alias=True)
        self.assertEqual(dumped["threadId"], "t-1")
        self.assertEqual(dumped["interrupts"][0]["toolCallId"], "tc-1")


if __name__ == "__main__":
    unittest.main()
