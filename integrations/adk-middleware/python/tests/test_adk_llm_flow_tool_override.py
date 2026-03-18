import pytest
from unittest.mock import MagicMock
from google.adk.agents import LlmAgent
from google.adk.tools.function_tool import FunctionTool
from google.adk.flows.llm_flows.base_llm_flow import BaseLlmFlow
from google.adk.models.llm_request import LlmRequest
from google.adk.agents.invocation_context import InvocationContext
from google.adk.sessions.session import Session
from google.adk.sessions.base_session_service import BaseSessionService


class TestAdkLlmFlowToolOverride:

    @pytest.mark.asyncio
    async def test_llm_flow_handles_tool_overrides(self):
        """Test that _preprocess_async properly handles both tools and toolsets."""

        # Define simple functions for the tools
        class ToolWrapper:
            @classmethod
            def fn_1(cls):
                "ToolWrapper.fn_1"
                pass

        def fn_1():
            "fn_1"
            pass

        def fn_2():
            "fn_2"
            pass


        # Create tools with overlapping names
        tool_2 = FunctionTool(fn_2)
        tool_2.name = 'fn_1'
        tool_1 = FunctionTool(fn_1)
        tool_1_class = FunctionTool(ToolWrapper.fn_1)

        # Create an agent with these tools
        agent = LlmAgent(
            name='test_agent', 
            tools=[
                tool_1,
                tool_1_class,
                tool_2, # This tool should override the others
            ]
        )

        # Create the invocation context
        mock_session = Session(
            id="test_session",
            app_name="test_app",
            user_id="test_user",
            events=[],
        )

        mock_session_service = MagicMock(spec=BaseSessionService)

        invocation_context = InvocationContext(
            agent=agent,
            session=mock_session,
            session_service=mock_session_service,
            invocation_id='test_invocation',
        )

        # Create the base flow
        flow = BaseLlmFlow()

        # Call _preprocess_async
        llm_request = LlmRequest()
        events = []
        async for event in flow._preprocess_async(invocation_context, llm_request):
            events.append(event)

        # Verify that tools with the same name are overridden correctly
        tools_dict = llm_request.tools_dict

        assert len(tools_dict) == 1
        assert 'fn_1' in tools_dict
        assert tools_dict['fn_1'].description == 'fn_2'