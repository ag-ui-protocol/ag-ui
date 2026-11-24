"""``forwardedProps.node_name`` and ``state`` come from the client.

In "continue" mode the adapter resumes the thread as it stands: no state write
and no stream input, so LangGraph runs only the tasks the thread has waiting.
These tests run a real graph with a gate node, so they show what a
client-chosen node name and state can and cannot do.
"""

import datetime as dt
import operator
from typing import Annotated, Any

import pytest
from pydantic import BaseModel

from fastapi import FastAPI
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict

from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from ag_ui_langgraph.agent import _changed_input_keys


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

    first = client.post("/agent", json=_same_turn_body("thread", "r1", {}, {}))
    assert first.status_code == 200
    assert ran == ["check_permission"]

    # check_permission did run last on this thread, so continuing from it is
    # legitimate. ``approved`` is not in the graph's input schema: the client
    # must not be able to set it on the way.
    ran.clear()
    second = client.post(
        "/agent",
        json=_same_turn_body(
            "thread", "r2", {"approved": True}, {"nodeName": "check_permission"}
        ),
    )

    assert second.status_code == 200
    # A continue: nothing in the input schema changed, so check_permission is
    # not run again, and the dropped ``approved`` cannot route past it.
    assert ran == []
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

    assert client.post("/agent", json=_same_turn_body("paused", "r1", {}, {})).status_code == 200
    assert ran == ["first_step"]

    ran.clear()
    response = client.post(
        "/agent", json=_same_turn_body("paused", "r2", {}, {"nodeName": "first_step"})
    )

    assert response.status_code == 200
    assert ran == ["second_step"]


def _steps_graph(ran: list[str]):
    """START -> first -> second -> third, paused before ``second``."""

    class Steps(TypedDict, total=False):
        messages: Annotated[list, add_messages]

    def step(name: str):
        def run(state: Steps) -> dict:
            ran.append(name)
            return {}

        return run

    builder = StateGraph(Steps)
    for name in ("first", "second", "third"):
        builder.add_node(name, step(name))
    builder.add_edge(START, "first")
    builder.add_edge("first", "second")
    builder.add_edge("second", "third")
    builder.add_edge("third", END)
    return builder.compile(checkpointer=MemorySaver(), interrupt_before=["second"])


def _client_for(graph, name: str = "agent") -> TestClient:
    app = FastAPI()
    add_langgraph_fastapi_endpoint(app, LangGraphAgent(name=name, graph=graph), "/agent")
    return TestClient(app)


def test_node_name_is_refused_when_the_latest_checkpoint_came_from_update_state():
    ran: list[str] = []
    graph = _steps_graph(ran)
    client = _client_for(graph)

    assert client.post("/agent", json=_body("t", "r1", {}, {})).status_code == 200
    assert ran == ["first"]

    # A continue from ``first`` wrote the latest checkpoint and stopped before
    # any step ran. The checkpoint before it lists ``second`` as next, but
    # ``second`` never ran.
    graph.update_state(
        {"configurable": {"thread_id": "t"}}, {}, as_node="first"
    )
    latest = graph.get_state({"configurable": {"thread_id": "t"}})
    assert latest.metadata["source"] == "update"

    ran.clear()
    response = client.post("/agent", json=_body("t", "r2", {}, {"nodeName": "second"}))

    assert response.status_code == 200
    # Continuing "from second" would skip it and run ``third``. Refused, the
    # request is a new run, which pauses before ``second`` again.
    assert "third" not in ran
    assert ran == ["first"]


def _approval_graph(ran: list[str]):
    """START -> ask (interrupt) -> act."""
    from langgraph.types import interrupt

    class Approval(TypedDict, total=False):
        messages: Annotated[list, add_messages]
        answer: str

    def ask(state: Approval) -> dict:
        answer = interrupt({"question": "proceed?"})
        ran.append(f"ask:{answer}")
        return {"answer": answer}

    def act(state: Approval) -> dict:
        ran.append(f"act:{state.get('answer')}")
        return {}

    builder = StateGraph(Approval)
    builder.add_node("ask", ask)
    builder.add_node("act", act)
    builder.add_edge(START, "ask")
    builder.add_edge("ask", "act")
    builder.add_edge("act", END)
    return builder.compile(checkpointer=MemorySaver())


def test_resume_with_the_interrupted_node_name_still_resumes():
    """CopilotKit sends ``command.resume`` together with the node that interrupted."""
    ran: list[str] = []
    client = _client_for(_approval_graph(ran))

    first = client.post("/agent", json=_body("hitl", "r1", {}, {}))
    assert first.status_code == 200
    assert ran == []

    response = client.post(
        "/agent",
        json=_body(
            "hitl", "r2", {}, {"command": {"resume": "yes"}, "nodeName": "ask"}
        ),
    )

    assert response.status_code == 200
    assert ran == ["ask:yes", "act:yes"]


def test_interrupted_node_name_without_a_resume_does_not_continue():
    """Naming the interrupted node without a resume value does not get past it.

    The node never finished, so the history does not back it: the request is
    no longer treated as a continue (before the fix it was). The outcome is the
    same as before: the thread still has an open interrupt, so the adapter
    reports that interrupt again and the graph does not run.
    """
    ran: list[str] = []
    graph = _approval_graph(ran)
    client = _client_for(graph)

    assert client.post("/agent", json=_body("hitl", "r1", {}, {})).status_code == 200

    response = client.post("/agent", json=_body("hitl", "r2", {}, {"nodeName": "ask"}))

    assert response.status_code == 200
    assert ran == []
    assert "proceed?" in response.text
    state = graph.get_state({"configurable": {"thread_id": "hitl"}})
    assert state.next == ("ask",)


def test_a_subgraph_node_name_is_refused_for_continue():
    """Thread history lists only top-level nodes, so a subgraph node name never
    backs a continue: the request starts a new run (with a warning)."""
    ran: list[str] = []

    class Inner(TypedDict, total=False):
        messages: Annotated[list, add_messages]

    def inner(name: str):
        def run(state: Inner) -> dict:
            ran.append(name)
            return {}

        return run

    sub = StateGraph(Inner)
    sub.add_node("inner_a", inner("inner_a"))
    sub.add_node("inner_b", inner("inner_b"))
    sub.add_edge(START, "inner_a")
    sub.add_edge("inner_a", "inner_b")
    sub.add_edge("inner_b", END)

    parent = StateGraph(Inner)
    parent.add_node("sub", sub.compile())
    parent.add_edge(START, "sub")
    parent.add_edge("sub", END)
    client = _client_for(parent.compile(checkpointer=MemorySaver()))

    assert client.post("/agent", json=_body("nested", "r1", {}, {})).status_code == 200
    assert ran == ["inner_a", "inner_b"]

    ran.clear()
    response = client.post(
        "/agent", json=_body("nested", "r2", {}, {"nodeName": "inner_a"})
    )

    assert response.status_code == 200
    assert "RUN_ERROR" not in response.text
    assert ran == ["inner_a", "inner_b"]


class ResourceState(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    resource: str
    approved: bool


class ResourceInput(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    resource: str


def _resource_gate_client(ran: list):
    """START -> gate -> (approved ? act : END), paused before ``act``.

    ``gate`` approves only the public resource; ``act`` uses whatever resource
    is in state when it runs. ``approved`` is private: not in the input schema.
    """

    def gate(state: ResourceState) -> dict:
        ran.append(("gate", state.get("resource")))
        return {"approved": state.get("resource") == "public"}

    def route(state: ResourceState) -> str:
        return "act" if state.get("approved") else END

    def act(state: ResourceState) -> dict:
        ran.append(("act", state.get("resource"), state.get("approved")))
        return {}

    builder = StateGraph(ResourceState, input_schema=ResourceInput)
    builder.add_node("gate", gate)
    builder.add_node("act", act)
    builder.add_edge(START, "gate")
    builder.add_conditional_edges("gate", route, ["act", END])
    builder.add_edge("act", END)
    graph = builder.compile(checkpointer=MemorySaver(), interrupt_before=["act"])
    return _client_for(graph), graph


def _same_turn_body(thread_id: str, run_id: str, state: Any, forwarded_props: dict) -> dict:
    """A request that re-sends the thread's existing message, adding none."""
    return {**_body(thread_id, run_id, state, forwarded_props),
            "messages": [{"id": "m-turn", "role": "user", "content": "go"}]}


def test_continue_does_not_carry_changed_input_past_the_check():
    """The gate approved ``public``. Continuing from it with ``private`` must
    not run ``act`` on ``private``: the input changed, so the gate decides again."""
    ran: list = []
    client, _ = _resource_gate_client(ran)

    first = client.post(
        "/agent", json=_same_turn_body("res", "r1", {"resource": "public"}, {})
    )
    assert first.status_code == 200
    assert ran == [("gate", "public")]

    second = client.post(
        "/agent",
        json=_same_turn_body(
            "res", "r2", {"resource": "private"}, {"nodeName": "gate"}
        ),
    )

    assert second.status_code == 200
    assert "RUN_ERROR" not in second.text
    assert ("act", "private", True) not in ran
    # The request is a new run: the gate checks ``private`` and refuses it.
    assert ran == [("gate", "public"), ("gate", "private")]


def test_continue_with_a_new_message_starts_a_new_run():
    """A new message is changed input too: the nodes before the named one
    have not seen it, so the run starts from START."""
    ran: list = []
    client, _ = _resource_gate_client(ran)

    assert client.post(
        "/agent", json=_body("res-msg", "r1", {"resource": "public"}, {})
    ).status_code == 200

    response = client.post(
        "/agent",
        json=_body("res-msg", "r2", {"resource": "public"}, {"nodeName": "gate"}),
    )

    assert response.status_code == 200
    assert ran == [("gate", "public"), ("gate", "public")]


def test_continue_with_unchanged_input_goes_on_past_the_check():
    """The same input the gate approved continues to ``act``."""
    ran: list = []
    client, _ = _resource_gate_client(ran)

    assert client.post(
        "/agent", json=_same_turn_body("res-ok", "r1", {"resource": "public"}, {})
    ).status_code == 200

    response = client.post(
        "/agent",
        json=_same_turn_body(
            "res-ok", "r2", {"resource": "public"}, {"nodeName": "gate"}
        ),
    )

    assert response.status_code == 200
    assert ran == [("gate", "public"), ("act", "public", True)]


class AmountState(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    amount: Annotated[int, operator.add]
    approved: bool


class AmountInput(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    amount: Annotated[int, operator.add]


def _amount_gate_client(ran: list):
    """START -> gate -> (approved ? act : END), paused before ``act``.

    ``amount`` has a reducer (``operator.add``): a write adds to the stored
    value, it does not replace it. ``gate`` approves an amount up to 100.
    """

    def gate(state: AmountState) -> dict:
        ran.append(("gate", state.get("amount")))
        return {"approved": state.get("amount", 0) <= 100}

    def route(state: AmountState) -> str:
        return "act" if state.get("approved") else END

    def act(state: AmountState) -> dict:
        ran.append(("act", state.get("amount"), state.get("approved")))
        return {}

    builder = StateGraph(AmountState, input_schema=AmountInput)
    builder.add_node("gate", gate)
    builder.add_node("act", act)
    builder.add_edge(START, "gate")
    builder.add_conditional_edges("gate", route, ["act", END])
    builder.add_edge("act", END)
    graph = builder.compile(checkpointer=MemorySaver(), interrupt_before=["act"])
    return _client_for(graph), graph


def test_continue_does_not_write_an_unchanged_value_through_a_reducer():
    """The gate approved 100. A continue that re-sends 100 looks unchanged,
    but writing it through the ``operator.add`` reducer makes the stored
    amount 200, which the gate never checked. The continue must not write it:
    ``act`` runs on the amount the gate approved."""
    ran: list = []
    client, graph = _amount_gate_client(ran)

    first = client.post(
        "/agent", json=_same_turn_body("amt", "r1", {"amount": 100}, {})
    )
    assert first.status_code == 200
    assert ran == [("gate", 100)]

    second = client.post(
        "/agent",
        json=_same_turn_body("amt", "r2", {"amount": 100}, {"nodeName": "gate"}),
    )

    assert second.status_code == 200
    assert "RUN_ERROR" not in second.text
    assert ("act", 200, True) not in ran
    assert ran == [("gate", 100), ("act", 100, True)]
    state = graph.get_state({"configurable": {"thread_id": "amt"}})
    assert state.values["amount"] == 100


# --- durability="exit" ------------------------------------------------------
#
# With ``durability="exit"`` LangGraph saves one checkpoint per run, so the two
# latest checkpoints can come from different runs and the history check alone
# cannot prove that the named node finished. The continue must not depend on
# it: it resumes only the thread's pending tasks, so it cannot skip a node.

DURABILITIES = [None, "exit"]


def _agent_with(durability, trust_history=False):
    """A ``LangGraphAgent`` that runs with ``durability`` (set by the operator,
    as a deployment would). With ``trust_history`` the history check always
    agrees, to test the continue on its own."""

    class Agent(LangGraphAgent):
        def get_stream_kwargs(self, *args, **kwargs):
            out = super().get_stream_kwargs(*args, **kwargs)
            if durability:
                out["durability"] = durability
            return out

        if trust_history:
            async def _ran_in_latest_step(self, config, node_name):
                return True

    return Agent


class UserState(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    user: str


def _exit_client(graph, durability, trust_history=False) -> TestClient:
    app = FastAPI()
    agent_cls = _agent_with(durability, trust_history)
    add_langgraph_fastapi_endpoint(app, agent_cls(name="agent", graph=graph), "/agent")
    return TestClient(app, raise_server_exceptions=False)


def _raising_gate_graph(ran: list[str]):
    """START -> gate -> act; ``gate`` raises for anyone but an admin."""

    def gate(state: UserState) -> dict:
        ran.append("gate")
        if state.get("user") != "admin":
            raise PermissionError("admins only")
        return {}

    def act(state: UserState) -> dict:
        ran.append("act")
        return {}

    builder = StateGraph(UserState)
    builder.add_node("gate", gate)
    builder.add_node("act", act)
    builder.add_edge(START, "gate")
    builder.add_edge("gate", "act")
    builder.add_edge("act", END)
    return builder.compile(checkpointer=MemorySaver())


def _pay_graph(ran: list[str]):
    """START -> quote -> pay -> deliver, paused before ``pay``."""

    def step(name: str):
        def run(state: UserState) -> dict:
            ran.append(name)
            return {}

        return run

    builder = StateGraph(UserState)
    for name in ("quote", "pay", "deliver"):
        builder.add_node(name, step(name))
    builder.add_edge(START, "quote")
    builder.add_edge("quote", "pay")
    builder.add_edge("pay", "deliver")
    builder.add_edge("deliver", END)
    return builder.compile(checkpointer=MemorySaver(), interrupt_before=["pay"])


def _user_body(run_id: str, forwarded_props: dict) -> dict:
    return _same_turn_body("t", run_id, {"user": "mallory"}, forwarded_props)


@pytest.mark.parametrize("trust_history", [False, True])
@pytest.mark.parametrize("durability", DURABILITIES)
def test_a_gate_that_refused_cannot_be_continued_past(durability, trust_history):
    ran: list[str] = []
    client = _exit_client(_raising_gate_graph(ran), durability, trust_history)

    # The gate refuses twice. Under exit durability that leaves two "loop"
    # checkpoints whose ``next`` is ``gate``, as if ``gate`` had just run.
    client.post("/agent", json=_user_body("r1", {}))
    client.post("/agent", json=_user_body("r2", {}))
    assert ran == ["gate", "gate"]

    ran.clear()
    response = client.post("/agent", json=_user_body("r3", {"nodeName": "gate"}))

    assert response.status_code == 200
    assert "act" not in ran
    assert ran == ["gate"]


@pytest.mark.parametrize("trust_history", [False, True])
@pytest.mark.parametrize("durability", DURABILITIES)
def test_a_node_that_never_ran_cannot_be_continued_past(durability, trust_history):
    ran: list[str] = []
    client = _exit_client(_pay_graph(ran), durability, trust_history)

    client.post("/agent", json=_user_body("r1", {}))
    client.post("/agent", json=_user_body("r2", {}))
    assert "pay" not in ran

    ran.clear()
    response = client.post("/agent", json=_user_body("r3", {"nodeName": "pay"}))

    assert response.status_code == 200
    assert "deliver" not in ran or ran.index("pay") < ran.index("deliver")
    # The history backs no continue from ``pay``: a new run, paused again
    # before ``pay``. With the history check bypassed, the continue resumes
    # the pending ``pay`` before ``deliver``.
    assert ran == (["pay", "deliver"] if trust_history else ["quote"])


# --- comparing the client's echo with the stored state -----------------------


class _Model(BaseModel):
    a: int = 1


class _Uncomparable:
    def __eq__(self, other):
        raise ValueError("truth value of an array is ambiguous")


def test_an_echo_of_the_json_form_is_unchanged():
    at = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    current = {"at": at, "tags": {"x"}, "model": _Model(), "order": {"a": 1, "b": 2}}
    echo = {"at": "2026-01-01T00:00:00Z", "tags": ["x"], "model": {"a": 1}, "order": {"b": 2, "a": 1}}

    assert _changed_input_keys(echo, current) == []
    assert _changed_input_keys({"at": "2025-01-01T00:00:00Z"}, current) == ["at"]


def test_a_value_that_cannot_be_compared_counts_as_changed():
    assert _changed_input_keys({"arr": [1, 2]}, {"arr": _Uncomparable()}) == ["arr"]
