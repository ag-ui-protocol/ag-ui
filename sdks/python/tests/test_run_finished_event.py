import unittest
from pydantic import ValidationError

from ag_ui.core.events import (
    EventType,
    RunFinishedEvent,
    RunFinishedSuccessOutcome,
    RunFinishedInterruptOutcome,
)
from ag_ui.core.types import Interrupt


class RunFinishedEventTest(unittest.TestCase):
    def test_legacy_event_with_no_outcome(self):
        e = RunFinishedEvent(thread_id="t-1", run_id="r-1")
        self.assertIsNone(e.outcome)
        self.assertIsNone(e.result)

    def test_legacy_event_with_result_only(self):
        e = RunFinishedEvent(thread_id="t-1", run_id="r-1", result={"ok": True})
        self.assertIsNone(e.outcome)
        self.assertEqual(e.result, {"ok": True})

    def test_explicit_success_outcome(self):
        e = RunFinishedEvent(
            thread_id="t-1",
            run_id="r-1",
            outcome=RunFinishedSuccessOutcome(),
            result={"ok": True},
        )
        assert isinstance(e.outcome, RunFinishedSuccessOutcome)
        self.assertEqual(e.outcome.type, "success")
        self.assertEqual(e.result, {"ok": True})

    def test_explicit_interrupt_outcome(self):
        e = RunFinishedEvent(
            thread_id="t-1",
            run_id="r-1",
            outcome=RunFinishedInterruptOutcome(
                interrupts=[Interrupt(id="int-1", reason="tool_call")],
            ),
        )
        assert isinstance(e.outcome, RunFinishedInterruptOutcome)
        self.assertEqual(e.outcome.type, "interrupt")
        self.assertEqual(len(e.outcome.interrupts), 1)

    def test_outcome_via_dict_discriminator(self):
        e = RunFinishedEvent.model_validate(
            {
                "type": EventType.RUN_FINISHED,
                "threadId": "t-1",
                "runId": "r-1",
                "outcome": {
                    "type": "interrupt",
                    "interrupts": [{"id": "int-1", "reason": "tool_call"}],
                },
            }
        )
        assert isinstance(e.outcome, RunFinishedInterruptOutcome)
        self.assertEqual(len(e.outcome.interrupts), 1)

    def test_interrupt_outcome_rejects_empty_interrupts(self):
        with self.assertRaises(ValidationError):
            RunFinishedInterruptOutcome(interrupts=[])

    def test_interrupt_outcome_via_dict_rejects_empty(self):
        with self.assertRaises(ValidationError):
            RunFinishedEvent.model_validate(
                {
                    "type": EventType.RUN_FINISHED,
                    "threadId": "t-1",
                    "runId": "r-1",
                    "outcome": {"type": "interrupt", "interrupts": []},
                }
            )

    def test_camel_case_serialization(self):
        e = RunFinishedEvent(
            thread_id="t-1",
            run_id="r-1",
            outcome=RunFinishedInterruptOutcome(
                interrupts=[Interrupt(id="int-1", reason="tool_call", tool_call_id="tc-1")],
            ),
        )
        dumped = e.model_dump(by_alias=True)
        self.assertEqual(dumped["threadId"], "t-1")
        self.assertEqual(dumped["outcome"]["type"], "interrupt")
        self.assertEqual(dumped["outcome"]["interrupts"][0]["toolCallId"], "tc-1")

    def test_legacy_event_serialization_omits_outcome(self):
        e = RunFinishedEvent(thread_id="t-1", run_id="r-1")
        dumped = e.model_dump(by_alias=True, exclude_none=True)
        self.assertNotIn("outcome", dumped)


if __name__ == "__main__":
    unittest.main()
