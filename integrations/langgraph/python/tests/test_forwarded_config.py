"""Tests for forwardedProps.config parity with the TypeScript adapter — fixes #2605.

The bug: ``prepare_stream`` built the run config from ``self.config`` plus
``thread_id`` and never read ``forwarded_props["config"]``, so the documented
per-run ``configurable`` values (see CopilotKit's "Passing configurables"
page) never reached a node's ``RunnableConfig``. The TypeScript adapter merges
``forwardedProps?.config`` into the run config (``mergeConfigs``, agent.ts),
so the two adapters disagreed on a documented input.

The fix merges ``forwardedProps.config`` into the run config in
``prepare_stream`` and ``prepare_regenerate_stream``: declared
``configurable`` keys merge under the run config's existing keys (adapter
values such as ``thread_id`` always win), undeclared ``configurable`` keys
are filtered out the way the TS adapter filters over ``schemaKeys.config`` +
``schemaKeys.context``, and undeclared top-level keys (``recursion_limit``)
pass through.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from tests._helpers import make_agent


def _make_input(thread_id="t1", forwarded_props=None):
    inp = MagicMock()
    inp.thread_id = thread_id
    inp.tools = []
    inp.forwarded_props = forwarded_props or {}
    inp.resume = None
    inp.state = {}
    inp.messages = []
    return inp


def _schema_keys(config_keys):
    """A ``get_schema_keys`` stand-in returning a fixed schema map."""
    return {
        "input": ["messages"],
        "output": ["messages"],
        "config": list(config_keys),
        "context": [],
    }


class TestPrepareStreamMergesForwardedConfig(unittest.IsolatedAsyncioTestCase):
    """Regression tests: forwardedProps.config must reach the run config."""

    def _agent(self, config_keys=None):
        agent = make_agent()
        if config_keys is None:
            # get_schema_keys untouched: make_agent's mock graph returns the
            # default fallback (config=[], context=[]) — the same "no schema
            # declared" case as a plain hand-built graph.
            agent.active_run = {"id": "run-1", "mode": "start"}
        else:
            agent.get_schema_keys = MagicMock(return_value=_schema_keys(config_keys))
            agent.active_run = {"id": "run-1", "mode": "start", "schema_keys": _schema_keys(config_keys)}
        agent.langgraph_default_merge_state = MagicMock(return_value={"messages": []})
        return agent

    async def test_declared_configurable_reaches_stream_config(self):
        """The documented example: a node reads
        ``config['configurable'].get('authToken')``; the value forwarded by
        the frontend must survive into the config handed to ``astream_events``."""
        agent = self._agent()

        state = MagicMock()
        state.values = {"messages": []}
        state.tasks = ()
        agent.graph.aget_state = AsyncMock(return_value=state)

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture

        forwarded = {"config": {"configurable": {"authToken": "tok-123"}}}
        await agent.prepare_stream(
            input=_make_input(forwarded_props=forwarded), agent_state=state, config={"configurable": {}}
        )

        configurable = captured["config"]["configurable"]
        self.assertEqual(configurable.get("authToken"), "tok-123")
        self.assertEqual(configurable.get("thread_id"), "t1")

    async def test_no_declared_schema_passes_configurable_through(self):
        """Most hand-built graphs declare no config schema (the issue's own
        reproduction among them) yet still read ``configurable`` — so with an
        empty schema the forwarded keys pass through, minus the LangGraph-
        owned checkpoint keys the frontend must never write."""
        agent = self._agent(config_keys=None)

        state = MagicMock()
        state.values = {"messages": []}
        state.tasks = ()
        agent.graph.aget_state = AsyncMock(return_value=state)

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture

        forwarded = {"config": {"configurable": {"authToken": "tok-123", "checkpoint_id": "evil"}}}
        await agent.prepare_stream(
            input=_make_input(forwarded_props=forwarded), agent_state=state, config={"configurable": {}}
        )

        configurable = captured["config"]["configurable"]
        self.assertEqual(configurable.get("authToken"), "tok-123")
        self.assertNotIn("checkpoint_id", configurable)

    async def test_top_level_keys_pass_through(self):
        """``recursion_limit`` — shown by the docs page as a sibling of
        ``configurable`` — is a top-level config key and is not part of the
        declared-configurable filter, so it must reach the stream config."""
        agent = self._agent(config_keys=[])

        state = MagicMock()
        state.values = {"messages": []}
        state.tasks = ()
        agent.graph.aget_state = AsyncMock(return_value=state)

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture

        forwarded = {"config": {"recursion_limit": 50, "configurable": {"authToken": "tok-123"}}}
        await agent.prepare_stream(
            input=_make_input(forwarded_props=forwarded), agent_state=state, config={"configurable": {}}
        )

        self.assertEqual(captured["config"].get("recursion_limit"), 50)

    async def test_declared_schema_filters_undeclared_keys(self):
        """When the graph declares a config schema, only keys declared in
        config/context merge — mirroring the TS adapter's
        filterObjectBySchemaKeys; a declared schema means LangGraph will
        validate, so unknown keys must not reach the run."""
        agent = self._agent(config_keys=["region"])

        state = MagicMock()
        state.values = {"messages": []}
        state.tasks = ()
        agent.graph.aget_state = AsyncMock(return_value=state)

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture

        forwarded = {
            "config": {
                "configurable": {
                    "region": "eu",
                    "authToken": "tok-123",
                    "checkpoint_ns": "evil",
                }
            }
        }
        await agent.prepare_stream(
            input=_make_input(forwarded_props=forwarded), agent_state=state, config={"configurable": {}}
        )

        configurable = captured["config"]["configurable"]
        self.assertEqual(configurable.get("region"), "eu")
        self.assertNotIn("authToken", configurable)
        self.assertNotIn("checkpoint_ns", configurable)

    async def test_adapter_owned_keys_never_lose_to_forwarded_values(self):
        """A malicious or careless frontend must not be able to point the run
        at another thread: ``thread_id`` is already on the run config when the
        merge runs, and existing keys win."""
        agent = self._agent(config_keys=["thread_id", "authToken"])

        state = MagicMock()
        state.values = {"messages": []}
        state.tasks = ()
        agent.graph.aget_state = AsyncMock(return_value=state)

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture

        forwarded = {
            "config": {
                "configurable": {
                    "thread_id": "evil-thread",
                    "authToken": "tok-123",
                }
            }
        }
        await agent.prepare_stream(
            input=_make_input(forwarded_props=forwarded), agent_state=state, config={"configurable": {}}
        )

        configurable = captured["config"]["configurable"]
        self.assertEqual(configurable.get("thread_id"), "t1")
        self.assertEqual(configurable.get("authToken"), "tok-123")

    async def test_absent_or_malformed_forwarded_config_is_ignored(self):
        """No ``config`` key, or a non-dict one, changes nothing."""
        agent = self._agent()

        state = MagicMock()
        state.values = {"messages": []}
        state.tasks = ()
        agent.graph.aget_state = AsyncMock(return_value=state)

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture

        await agent.prepare_stream(
            input=_make_input(forwarded_props={"config": "not-a-dict"}),
            agent_state=state,
            config={"configurable": {}},
        )

        self.assertEqual(captured["config"]["configurable"], {"thread_id": "t1"})


class TestPrepareRegenerateStreamMergesForwardedConfig(unittest.IsolatedAsyncioTestCase):
    """The regeneration (time-travel) path must honor forwardedProps.config too."""

    async def test_declared_configurable_survives_regeneration(self):
        agent = make_agent()
        agent.active_run = {"id": "run-1", "schema_keys": _schema_keys(("authToken",))}

        snapshot = MagicMock()
        snapshot.config = {"configurable": {"thread_id": "t1", "checkpoint_id": "cp-before"}}
        snapshot.values = {"messages": []}
        snapshot.next = ("agent",)
        agent.get_checkpoint_before_message = AsyncMock(return_value=snapshot)
        agent.graph.aupdate_state = AsyncMock(
            return_value={"configurable": {"thread_id": "t1", "checkpoint_id": "cp-after-fork"}}
        )
        agent.langgraph_default_merge_state = MagicMock(return_value={"messages": []})

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture

        forwarded = {"config": {"configurable": {"authToken": "tok-123"}}}
        message = MagicMock()
        message.id = "h1"

        await agent.prepare_regenerate_stream(
            input=_make_input(forwarded_props=forwarded), message_checkpoint=message, config={"configurable": {}}
        )

        self.assertEqual(captured["config"]["configurable"].get("authToken"), "tok-123")


if __name__ == "__main__":
    unittest.main()
