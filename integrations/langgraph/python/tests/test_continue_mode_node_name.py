"""``forwardedProps.node_name`` and ``state`` come from the client.

In "continue" mode the adapter calls ``aupdate_state(config, state,
as_node=node_name)``: LangGraph then treats that node as having just run and
goes on from its successors. These tests run a real graph with a gate node, so
they show what a client-chosen node name and state can and cannot do.
"""

from typing import Annotated, Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict

from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint


class GateState(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    approved: bool
    result: str


class GateInput(TypedDict, total=False):
    messages: Annotated[list, add_messages]


def _gate_client(ran: list[str]) -> TestClient:
    """START -> check_permission -> (approved? sensitive_action : END)."""

    def check_permission(state: GateState) -> dict:
        ran.append("check_permission")
        return {"approved": False}

    def route(state: GateState) -> str:
        return "sensitive_action" if state.get("approved") else END

    def sensitive_action(state: GateState) -> dict:
        ran.append("sensitive_action")
        return {"result": "secret released"}

    builder = StateGraph(GateState, input_schema=GateInput)
    builder.add_node("check_permission", check_permission)
    builder.add_node("sensitive_action", sensitive_action)
    builder.add_edge(START, "check_permission")
    builder.add_conditional_edges("check_permission", route, ["sensitive_action", END])
    builder.add_edge("sensitive_action", END)

    app = FastAPI()
    add_langgraph_fastapi_endpoint(
        app,
        LangGraphAgent(name="gate", graph=builder.compile(checkpointer=MemorySaver())),
        "/agent",
    )
    return TestClient(app)


def _body(thread_id: str, run_id: str, state: Any, forwarded_props: dict) -> dict:
    return {
        "threadId": thread_id,
        "runId": run_id,
        "state": state,
        "tools": [],
        "context": [],
        "messages": [{"id": f"m-{run_id}", "role": "user", "content": "go"}],
        "forwardedProps": forwarded_props,
    }


def test_node_name_on_a_new_thread_does_not_skip_the_gate():
    ran: list[str] = []
    client = _gate_client(ran)

    response = client.post(
        "/agent",
        json=_body(
            "new-thread", "r1", {"approved": True}, {"nodeName": "check_permission"}
        ),
    )

    assert response.status_code == 200
    assert "sensitive_action" not in ran
    assert "secret released" not in response.text
    # Nothing ran on this thread before, so there is nothing to continue: the
    # request is a new run and the gate decides.
    assert ran == ["check_permission"]


def test_continue_writes_only_the_input_schema():
    ran: list[str] = []
    client = _gate_client(ran)

    first = client.post("/agent", json=_body("thread", "r1", {}, {}))
    assert first.status_code == 200
    assert ran == ["check_permission"]

    # check_permission did run last on this thread, so continuing from it is
    # legitimate. ``approved`` is not in the graph's input schema: the client
    # must not be able to set it on the way.
    ran.clear()
    second = client.post(
        "/agent",
        json=_body(
            "thread", "r2", {"approved": True}, {"nodeName": "check_permission"}
        ),
    )

    assert second.status_code == 200
    assert "sensitive_action" not in ran
    assert "secret released" not in second.text


def test_continue_from_the_node_that_ran_last_still_works():
    ran: list[str] = []

    class Steps(TypedDict, total=False):
        messages: Annotated[list, add_messages]

    def first_step(state: Steps) -> dict:
        ran.append("first_step")
        return {}

    def second_step(state: Steps) -> dict:
        ran.append("second_step")
        return {}

    builder = StateGraph(Steps)
    builder.add_node("first_step", first_step)
    builder.add_node("second_step", second_step)
    builder.add_edge(START, "first_step")
    builder.add_edge("first_step", "second_step")
    builder.add_edge("second_step", END)
    graph = builder.compile(
        checkpointer=MemorySaver(), interrupt_before=["second_step"]
    )

    app = FastAPI()
    add_langgraph_fastapi_endpoint(
        app, LangGraphAgent(name="steps", graph=graph), "/agent"
    )
    client = TestClient(app)

    assert client.post("/agent", json=_body("paused", "r1", {}, {})).status_code == 200
    assert ran == ["first_step"]

    ran.clear()
    response = client.post(
        "/agent", json=_body("paused", "r2", {}, {"nodeName": "first_step"})
    )

    assert response.status_code == 200
    assert ran == ["second_step"]
