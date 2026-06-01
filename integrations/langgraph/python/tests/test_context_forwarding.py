"""Regression tests for forwarding runtime ``context`` to ``astream_events`` (#1815).

The agent must forward a runtime ``context=`` argument through to the graph's
``astream_events`` call. The real ``astream_events`` signature exposes
``context`` only via ``**kwargs`` (VAR_KEYWORD), so gating on the literal
``'context' in sig.parameters`` left the merge block dead and dropped context.
"""

import unittest

from ._helpers import make_agent


class TestContextForwarding(unittest.TestCase):
    def test_context_is_forwarded_to_stream_kwargs(self):
        agent = make_agent()
        config = {"configurable": {"thread_id": "t-1"}}
        ctx = {"user_id": "u-123", "tenant": "acme"}

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config=config,
            context=ctx,
        )

        self.assertIn("context", kwargs)
        # configurable values are merged in, with explicit context taking precedence
        self.assertEqual(kwargs["context"]["user_id"], "u-123")
        self.assertEqual(kwargs["context"]["tenant"], "acme")
        self.assertEqual(kwargs["context"]["thread_id"], "t-1")

    def test_no_context_key_when_nothing_to_pass(self):
        agent = make_agent()
        kwargs = agent.get_stream_kwargs(input={"messages": []})
        self.assertNotIn("context", kwargs)


if __name__ == "__main__":
    unittest.main()
