"""Session lifecycle regressions: lost-session recovery and resume-by-id."""

import inspect

from copilot import CopilotClient
from test_agent import FRONTEND_TOOL_TURN, TEXT_TURN, FakeClient, collect, make_input

from ag_ui_copilot_sdk import CopilotAgent

TOOLS = [
    {
        "name": "change_background",
        "description": "change it",
        "parameters": {"type": "object", "properties": {}},
    }
]
USER = {"id": "u1", "role": "user", "content": "Say hello."}
TOOL_RESULT = {"id": "t-1", "role": "tool", "toolCallId": "call-1", "content": "ok"}
RESOLVED_TRANSCRIPT = [
    USER,
    {
        "id": "a1",
        "role": "assistant",
        "toolCalls": [
            {
                "id": "call-1",
                "type": "function",
                "function": {"name": "change_background", "arguments": "{}"},
            }
        ],
    },
    TOOL_RESULT,
]


async def test_l1_resolved_tool_replay_after_timeout_accepts_new_user():
    client = FakeClient(FRONTEND_TOOL_TURN)
    agent = CopilotAgent(client, run_timeout=1)
    first = await collect(agent, make_input(tools=TOOLS))
    assert first[-1].type == "RUN_FINISHED"
    second = await collect(agent, make_input(runId="r2", tools=TOOLS, messages=RESOLVED_TRANSCRIPT))
    assert second[-1].type == "RUN_FINISHED"
    assert [r.request_id for r in client.session.resolved] == ["req-1"]
    assert agent._threads["t1"].pending == {}

    failed_transcript = RESOLVED_TRANSCRIPT + [
        {"id": "u2", "role": "user", "content": "This turn times out."}
    ]
    old_session = client.session
    old_session._stall = True
    agent.run_timeout = 0.02
    failed = await collect(agent, make_input(runId="r3", messages=failed_transcript))
    assert failed[-1].type == "RUN_ERROR"
    assert old_session.aborted
    assert "t1" not in agent._threads

    client._script = TEXT_TURN
    agent.run_timeout = 1
    recovered = await collect(
        agent,
        make_input(
            runId="r4",
            messages=failed_transcript
            + [{"id": "u3", "role": "user", "content": "Continue after the timeout."}],
        ),
    )
    assert recovered[-1].type == "RUN_FINISHED", recovered[-1]
    assert client.session is not old_session
    assert client.session.prompts == ["Continue after the timeout."]
    await agent.close()


async def test_l2_failed_run_resumes_the_same_native_session():
    signature = inspect.signature(CopilotClient.resume_session)
    signature.bind(None, "previous-session", on_event=lambda event: None, tools=[])
    assert "continue_pending_work" in signature.parameters

    client = FakeClient(TEXT_TURN)
    agent = CopilotAgent(client, run_timeout=1)
    assert (await collect(agent, make_input()))[-1].type == "RUN_FINISHED"
    old_session = client.session
    old_session._stall = True
    agent.run_timeout = 0.02
    failed_transcript = [USER, {"id": "u2", "role": "user", "content": "Fail."}]
    assert (await collect(agent, make_input(runId="r2", messages=failed_transcript)))[
        -1
    ].type == "RUN_ERROR"

    agent.run_timeout = 1
    events = await collect(
        agent,
        make_input(
            runId="r3",
            messages=failed_transcript
            + [{"id": "u3", "role": "user", "content": "Recall our earlier conversation."}],
        ),
    )
    assert events[-1].type == "RUN_FINISHED"
    assert client.session is not old_session
    assert client.session.prompts == ["Recall our earlier conversation."]
    assert len(client.stored) == 1
    assert client.resumed == list(client.stored)
    assert client.options.get("cloud") is None

    # Another agent on the same client and threadId gets its own session.
    other = CopilotAgent(client, run_timeout=1)
    assert (await collect(other, make_input(runId="r4")))[-1].type == "RUN_FINISHED"
    assert len(client.stored) == 2 and client.resumed == client.resumed[:1]
    await agent.close()
    await other.close()
