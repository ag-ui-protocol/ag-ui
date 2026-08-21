"""Tests for LangGraphAgent.clone() subclass preservation."""

import unittest
from unittest.mock import MagicMock

from ag_ui_langgraph import LangGraphAgent


class SubclassAgent(LangGraphAgent):
    """Test subclass that adds custom behavior."""

    def __init__(self, *, name, graph, description=None, config=None, enable_legacy_on_interrupt_event=True, emit_interrupt_outcome=False, emit_raw_events=True, custom_flag=False):
        super().__init__(name=name, graph=graph, description=description, config=config, enable_legacy_on_interrupt_event=enable_legacy_on_interrupt_event, emit_interrupt_outcome=emit_interrupt_outcome, emit_raw_events=emit_raw_events)
        self.custom_flag = custom_flag

    def custom_method(self):
        return "subclass behavior"


class LegacySignatureAgent(LangGraphAgent):
    """Subclass whose __init__ predates the emit/interrupt flags.

    This is the shape of ``copilotkit.LangGraphAGUIAgent``: a closed
    keyword-only signature accepting exactly the four parameters clone()
    documents. Every kwarg clone() adds beyond those four breaks it, and
    because add_langgraph_fastapi_endpoint clones per request, that break is
    a 500 on every request rather than a startup error.
    """

    def __init__(self, *, name, graph, description=None, config=None):
        super().__init__(name=name, graph=graph, description=description, config=config)


class TestClone(unittest.TestCase):
    """Test that clone() preserves subclass identity and behavior."""

    def _make_graph(self):
        """Create a mock compiled graph for testing."""
        graph = MagicMock()
        graph.config_specs = []
        return graph

    def test_clone_subclass_with_legacy_signature(self):
        """A subclass accepting only the four documented params must clone."""
        agent = LegacySignatureAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsInstance(cloned, LegacySignatureAgent)
        self.assertEqual(cloned.name, "test")

    def test_clone_carries_flags_through_legacy_signature(self):
        """Flags the subclass __init__ cannot accept still reach the clone.

        Dropping them would silently revert emit_raw_events=False to the
        default on every request, reintroducing the OSS-607 payload bloat
        with no error anywhere.
        """
        agent = LegacySignatureAgent(name="test", graph=self._make_graph())
        agent.emit_raw_events = False
        agent.emit_interrupt_outcome = True
        agent.enable_legacy_on_interrupt_event = False

        cloned = agent.clone()

        self.assertFalse(cloned.emit_raw_events)
        self.assertTrue(cloned.emit_interrupt_outcome)
        self.assertFalse(cloned.enable_legacy_on_interrupt_event)

    def test_clone_carries_flags_when_init_accepts_them(self):
        """The constructor path stays the one used when the subclass accepts it."""
        agent = SubclassAgent(
            name="test",
            graph=self._make_graph(),
            emit_raw_events=False,
            emit_interrupt_outcome=True,
        )
        cloned = agent.clone()
        self.assertFalse(cloned.emit_raw_events)
        self.assertTrue(cloned.emit_interrupt_outcome)

    def test_dispatch_event_survives_missing_flags(self):
        """Reading a flag must not require __init__ to have run.

        Flags introduced after the fact are class-level defaults, so instances
        built without them (partially constructed test doubles, subclasses that
        skip super().__init__) still dispatch instead of raising AttributeError.
        """
        agent = object.__new__(LegacySignatureAgent)
        self.assertTrue(agent.emit_raw_events)
        self.assertFalse(agent.emit_interrupt_outcome)
        self.assertTrue(agent.enable_legacy_on_interrupt_event)

    def test_clone_returns_same_class(self):
        """clone() should return an instance of the same class, not the base."""
        agent = SubclassAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsInstance(cloned, SubclassAgent)

    def test_clone_base_class(self):
        """clone() on the base class should still return LangGraphAgent."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsInstance(cloned, LangGraphAgent)

    def test_clone_copies_fields(self):
        """clone() should copy name, graph, description, and config."""
        graph = self._make_graph()
        config = {"recursion_limit": 50}
        agent = LangGraphAgent(
            name="my-agent",
            graph=graph,
            description="A test agent",
            config=config,
        )
        cloned = agent.clone()
        self.assertEqual(cloned.name, "my-agent")
        self.assertIs(cloned.graph, graph)
        self.assertEqual(cloned.description, "A test agent")
        self.assertEqual(cloned.config, config)

    def test_clone_shallow_copies_config(self):
        """clone() should shallow-copy config so mutations don't leak."""
        config = {"recursion_limit": 50}
        agent = LangGraphAgent(name="test", graph=self._make_graph(), config=config)
        cloned = agent.clone()
        self.assertEqual(cloned.config, config)
        self.assertIsNot(cloned.config, agent.config)

    def test_clone_subclass_has_overridden_methods(self):
        """clone() of a subclass should have the subclass's methods."""
        agent = SubclassAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertEqual(cloned.custom_method(), "subclass behavior")

    def test_clone_does_not_preserve_subclass_extra_state(self):
        """clone() only passes base-class params; subclass defaults apply."""
        agent = SubclassAgent(name="test", graph=self._make_graph(), custom_flag=True)
        cloned = agent.clone()
        # Documented limitation: custom_flag reverts to its default
        self.assertFalse(cloned.custom_flag)

    def test_clone_subclass_with_required_extra_param_raises(self):
        """Subclasses with extra required params must override clone()."""
        class StrictAgent(LangGraphAgent):
            def __init__(self, *, name, graph, api_key, description=None, config=None):
                super().__init__(name=name, graph=graph, description=description, config=config)
                self.api_key = api_key

        agent = StrictAgent(name="test", graph=self._make_graph(), api_key="sk-123")
        with self.assertRaises(TypeError) as ctx:
            agent.clone()
        self.assertIn("must override clone()", str(ctx.exception))

    def test_clone_with_no_config(self):
        """clone() with default (empty) config round-trips correctly."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertEqual(cloned.config, {})

    def test_clone_isolates_mutable_state(self):
        """clone() should produce a separate instance (not the same object)."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsNot(agent, cloned)
        self.assertIsNot(agent.messages_in_process, cloned.messages_in_process)


if __name__ == "__main__":
    unittest.main()
