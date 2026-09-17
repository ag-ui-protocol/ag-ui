"""
``RunAgentInput.tools`` and ``.context``: absent and empty are the same thing.

run-input.mdx says so in words, the field docstrings said so in words, and the
model said ``None`` — so ``for tool in input.tools`` raised TypeError on exactly
the shape the specification calls "none". TypeScript has always materialised an
absent one as ``[]`` (``z.array(ToolSchema).default(() => [])``); these tests
hold Python to the same reading.
"""

import json
import unittest

from pydantic import ValidationError

from ag_ui.core import RunAgentInput


MINIMAL = {"threadId": "t", "runId": "r", "messages": []}


class AbsentListsMaterialiseAsEmpty(unittest.TestCase):
    def test_absent_tools_and_context_read_as_empty_lists(self):
        parsed = RunAgentInput.model_validate(MINIMAL)

        self.assertEqual(parsed.tools, [])
        self.assertEqual(parsed.context, [])
        # The footgun this closes: iterating what the spec calls "none".
        self.assertEqual([tool.name for tool in parsed.tools], [])

    def test_constructing_without_them_gives_the_same_shape(self):
        built = RunAgentInput(thread_id="t", run_id="r", messages=[])

        self.assertEqual(built.tools, [])
        self.assertEqual(built.context, [])

    def test_the_default_is_a_factory_not_a_shared_list(self):
        first = RunAgentInput.model_validate(MINIMAL)
        second = RunAgentInput.model_validate(MINIMAL)

        first.tools.append(None)
        self.assertEqual(second.tools, [])

    def test_they_are_written_out_as_empty_lists(self):
        # The TypeScript client sends `[]` for both, and an empty list means
        # exactly what an absent key means, so writing them loses nothing and
        # keeps the two SDKs' requests identical.
        dumped = json.loads(RunAgentInput.model_validate(MINIMAL).model_dump_json(by_alias=True))

        self.assertEqual(dumped["tools"], [])
        self.assertEqual(dumped["context"], [])

    def test_an_explicit_null_is_rejected_rather_than_read_as_absent(self):
        # Neither field is in the null-means-absent shim, in TypeScript or here.
        with self.assertRaises(ValidationError):
            RunAgentInput.model_validate({**MINIMAL, "tools": None})
        with self.assertRaises(ValidationError):
            RunAgentInput.model_validate({**MINIMAL, "context": None})


if __name__ == "__main__":
    unittest.main()
