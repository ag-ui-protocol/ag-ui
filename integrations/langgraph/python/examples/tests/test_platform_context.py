import unittest

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.runtime import Runtime

from agents.agentic_chat.middleware import CopilotKitMiddleware


class TestPlatformContext(unittest.TestCase):
    def setUp(self):
        self.middleware = CopilotKitMiddleware()
        self.state = {"messages": [HumanMessage(content="Hi")], "copilotkit": {}}

    def test_platform_bookkeeping_does_not_become_a_model_message(self):
        context = {"__event_streaming_v2": True, "thread_id": "thread"}
        runtime = Runtime(context=context)
        self.assertIsNone(self.middleware.before_agent(self.state, runtime))
        self.assertEqual(context, runtime.context)

    def test_real_runtime_context_survives_transport_filtering(self):
        runtime = Runtime(context={"__event_streaming_v2": True, "thread_id": "thread", "customer": "Bob"})
        output = self.middleware.before_agent(self.state, runtime)
        message = output["messages"][0]
        self.assertIsInstance(message, SystemMessage)
        self.assertIn('"customer": "Bob"', message.content)
        self.assertNotIn("thread_id", message.content)
        self.assertNotIn("__event_streaming_v2", message.content)

    def test_explicit_application_context_keeps_precedence(self):
        self.state["copilotkit"]["context"] = {"thread_id": "application value"}
        output = self.middleware.before_agent(self.state, Runtime(context={"__event_streaming_v2": True, "thread_id": "transport"}))
        self.assertIn('"thread_id": "application value"', output["messages"][0].content)

    def test_v2_runtime_context_is_unchanged(self):
        output = self.middleware.before_agent(self.state, Runtime(context={"thread_id": "application value"}))
        self.assertIn('"thread_id": "application value"', output["messages"][0].content)

    def test_middleware_keeps_existing_graph_step_names(self):
        self.assertEqual("CopilotKitMiddleware", self.middleware.name)
