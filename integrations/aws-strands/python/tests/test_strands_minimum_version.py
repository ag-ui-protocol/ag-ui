"""Compatibility contract for the declared Strands Agents minimum version."""

from __future__ import annotations

import pytest
from ag_ui.core import Tool as AgUiTool
from strands import Agent

from ag_ui_strands.client_proxy_tool import create_proxy_tool
from ag_ui_strands.frontend_tool_wait import (
    FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
    frontend_tool_wait_reason,
    wrap_frontend_tool_response,
)


@pytest.mark.asyncio
async def test_waiting_proxy_interrupts_and_resumes_empty_result() -> None:
    """The public native interrupt path works on the declared 1.15.0 floor."""
    proxy = create_proxy_tool(
        AgUiTool(name="compat_tool", description="compatibility tool", parameters={}),
        continue_after_frontend_call=False,
    )
    native_agent = Agent(tools=[proxy])
    tool_use = {"toolUseId": "native-115", "name": "compat_tool", "input": {}}

    first_events = [
        event async for event in proxy.stream(tool_use, {"agent": native_agent})
    ]

    assert len(first_events) == 1
    interrupt = first_events[0]["tool_interrupt_event"]["interrupts"][0]
    assert interrupt.name == FRONTEND_TOOL_WAIT_INTERRUPT_NAME
    assert interrupt.reason == frontend_tool_wait_reason(
        native_tool_use_id="native-115"
    )

    interrupt.response = wrap_frontend_tool_response("", is_error=False)
    assert interrupt.response

    resumed_events = [
        event async for event in proxy.stream(tool_use, {"agent": native_agent})
    ]

    assert resumed_events == [
        {
            "tool_result": {
                "toolUseId": "native-115",
                "status": "success",
                "content": [{"text": ""}],
            }
        }
    ]
