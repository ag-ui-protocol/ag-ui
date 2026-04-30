import unittest

from ag_ui.core.capabilities import HumanInTheLoopCapabilities


class HumanInTheLoopCapabilitiesInterruptsTest(unittest.TestCase):
    def test_interrupts_flag(self):
        c = HumanInTheLoopCapabilities(interrupts=True)
        self.assertTrue(c.interrupts)

    def test_approve_with_edits_flag(self):
        c = HumanInTheLoopCapabilities(approve_with_edits=True)
        self.assertTrue(c.approve_with_edits)

    def test_camel_case_alias(self):
        c = HumanInTheLoopCapabilities(approve_with_edits=True)
        dumped = c.model_dump(by_alias=True, exclude_none=True)
        self.assertIn("approveWithEdits", dumped)
        self.assertNotIn("approve_with_edits", dumped)

    def test_parse_from_camel_case(self):
        c = HumanInTheLoopCapabilities.model_validate({"interrupts": True, "approveWithEdits": True})
        self.assertTrue(c.interrupts)
        self.assertTrue(c.approve_with_edits)


if __name__ == "__main__":
    unittest.main()
