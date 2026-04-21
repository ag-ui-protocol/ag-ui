import unittest

from ag_ui.core.capabilities import (
    AgentCapabilities,
    ExecutionCapabilities,
    HumanInTheLoopCapabilities,
    IdentityCapabilities,
    MultiAgentCapabilities,
    MultimodalCapabilities,
    MultimodalInputCapabilities,
    MultimodalOutputCapabilities,
    OutputCapabilities,
    ReasoningCapabilities,
    StateCapabilities,
    SubAgentInfo,
    ToolsCapabilities,
    TransportCapabilities,
)
from ag_ui.core.types import Tool


class TestWireFormatAlignment(unittest.TestCase):
    """
    Protocol alignment tests: the wire-format field names emitted by the Python
    SDK must match the TypeScript schema in
    `sdks/typescript/packages/core/src/capabilities.ts` exactly. Each assertion
    here pins one camelCase key that a cross-language client parses.
    """

    def test_empty_agent_capabilities_serializes_to_empty_object(self):
        """An agent that declares nothing sends `{}` on the wire, not a
        densely-populated tree of empty sub-objects."""
        serialized = AgentCapabilities().model_dump(by_alias=True, exclude_none=True)
        self.assertEqual(serialized, {})

    def test_agent_capabilities_top_level_keys_match_typescript(self):
        """Pins every top-level AgentCapabilities key against the TS schema."""
        caps = AgentCapabilities(
            identity=IdentityCapabilities(),
            transport=TransportCapabilities(),
            tools=ToolsCapabilities(),
            output=OutputCapabilities(),
            state=StateCapabilities(),
            multi_agent=MultiAgentCapabilities(),
            reasoning=ReasoningCapabilities(),
            multimodal=MultimodalCapabilities(),
            execution=ExecutionCapabilities(),
            human_in_the_loop=HumanInTheLoopCapabilities(),
            custom={},
        )
        serialized = caps.model_dump(by_alias=True)
        self.assertIn("identity", serialized)
        self.assertIn("transport", serialized)
        self.assertIn("tools", serialized)
        self.assertIn("output", serialized)
        self.assertIn("state", serialized)
        self.assertIn("multiAgent", serialized)
        self.assertIn("reasoning", serialized)
        # TS uses `multimodal` (single lowercase word), NOT `multiModal`.
        self.assertIn("multimodal", serialized)
        self.assertNotIn("multiModal", serialized)
        self.assertIn("execution", serialized)
        self.assertIn("humanInTheLoop", serialized)
        self.assertIn("custom", serialized)

    def test_identity_capabilities_camel_case_keys(self):
        ident = IdentityCapabilities(
            name="n",
            type="t",
            description="d",
            version="v",
            provider="p",
            documentation_url="https://example.com",
            metadata={"k": 1},
        )
        serialized = ident.model_dump(by_alias=True)
        self.assertIn("documentationUrl", serialized)
        self.assertNotIn("documentation_url", serialized)
        self.assertEqual(serialized["metadata"], {"k": 1})

    def test_transport_capabilities_camel_case_keys(self):
        transport = TransportCapabilities(
            streaming=True,
            websocket=False,
            http_binary=True,
            push_notifications=False,
            resumable=True,
        )
        serialized = transport.model_dump(by_alias=True)
        self.assertIn("httpBinary", serialized)
        self.assertIn("pushNotifications", serialized)
        self.assertNotIn("http_binary", serialized)
        self.assertNotIn("push_notifications", serialized)

    def test_tools_capabilities_camel_case_keys(self):
        tools = ToolsCapabilities(
            supported=True,
            items=[Tool(name="search", description="Search the web", parameters={})],
            parallel_calls=True,
            client_provided=False,
        )
        serialized = tools.model_dump(by_alias=True)
        self.assertIn("parallelCalls", serialized)
        self.assertIn("clientProvided", serialized)

    def test_output_capabilities_camel_case_keys(self):
        output = OutputCapabilities(
            structured_output=True,
            supported_mime_types=["application/json"],
        )
        serialized = output.model_dump(by_alias=True)
        self.assertIn("structuredOutput", serialized)
        self.assertIn("supportedMimeTypes", serialized)

    def test_state_capabilities_camel_case_keys(self):
        state = StateCapabilities(
            snapshots=True,
            deltas=True,
            memory=False,
            persistent_state=True,
        )
        serialized = state.model_dump(by_alias=True)
        self.assertIn("persistentState", serialized)

    def test_multi_agent_capabilities_camel_case_keys(self):
        multi_agent = MultiAgentCapabilities(
            supported=True,
            delegation=True,
            handoffs=False,
            sub_agents=[SubAgentInfo(name="planner", description="plans things")],
        )
        serialized = multi_agent.model_dump(by_alias=True)
        self.assertIn("subAgents", serialized)
        self.assertEqual(serialized["subAgents"][0]["name"], "planner")

    def test_execution_capabilities_camel_case_keys(self):
        execution = ExecutionCapabilities(
            code_execution=True,
            sandboxed=True,
            max_iterations=10,
            max_execution_time=30000,
        )
        serialized = execution.model_dump(by_alias=True)
        self.assertIn("codeExecution", serialized)
        self.assertIn("maxIterations", serialized)
        self.assertIn("maxExecutionTime", serialized)
        self.assertEqual(serialized["maxIterations"], 10)

    def test_human_in_the_loop_top_level_alias(self):
        caps = AgentCapabilities(
            human_in_the_loop=HumanInTheLoopCapabilities(supported=True)
        )
        serialized = caps.model_dump(by_alias=True, exclude_none=True)
        self.assertIn("humanInTheLoop", serialized)
        self.assertEqual(serialized["humanInTheLoop"], {"supported": True})

    def test_multimodal_nested_shape(self):
        caps = AgentCapabilities(
            multimodal=MultimodalCapabilities(
                input=MultimodalInputCapabilities(image=True, pdf=True),
                output=MultimodalOutputCapabilities(audio=True),
            )
        )
        serialized = caps.model_dump(by_alias=True, exclude_none=True)
        self.assertEqual(
            serialized["multimodal"],
            {"input": {"image": True, "pdf": True}, "output": {"audio": True}},
        )


class TestRoundTrip(unittest.TestCase):
    """Parse what we serialize (wire format) and serialize what we parse."""

    def test_round_trip_from_camel_case_payload(self):
        payload = {
            "identity": {
                "name": "agent-x",
                "documentationUrl": "https://example.com/docs",
                "metadata": {"team": "platform"},
            },
            "transport": {"streaming": True, "httpBinary": True},
            "tools": {"supported": True, "parallelCalls": False},
            "multiAgent": {"supported": True, "subAgents": [{"name": "planner"}]},
            "multimodal": {"input": {"image": True}, "output": {"audio": True}},
            "execution": {"codeExecution": True, "maxIterations": 5},
            "humanInTheLoop": {"approvals": True},
            "custom": {"integration": "langgraph"},
        }
        caps = AgentCapabilities.model_validate(payload)
        # attribute-side is snake_case
        self.assertEqual(caps.identity.documentation_url, "https://example.com/docs")
        self.assertTrue(caps.transport.http_binary)
        self.assertFalse(caps.tools.parallel_calls)
        self.assertEqual(caps.multi_agent.sub_agents[0].name, "planner")
        self.assertTrue(caps.multimodal.input.image)
        self.assertEqual(caps.execution.max_iterations, 5)
        self.assertTrue(caps.human_in_the_loop.approvals)
        # round-trip preserves the camelCase wire format
        round_tripped = caps.model_dump(by_alias=True, exclude_none=True)
        self.assertEqual(round_tripped, payload)

    def test_sub_agent_info_required_name(self):
        with self.assertRaises(Exception):
            SubAgentInfo()  # type: ignore[call-arg]
        sa = SubAgentInfo(name="only-name")
        self.assertEqual(sa.name, "only-name")
        self.assertIsNone(sa.description)


if __name__ == "__main__":
    unittest.main()
