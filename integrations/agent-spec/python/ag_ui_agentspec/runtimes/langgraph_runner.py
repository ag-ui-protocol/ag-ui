"""Run a LangGraph agent compiled from Agent Spec with AG-UI / CopilotKit semantics.

The graph is typically built with ``langchain.agents.create_agent``. That stack binds
tools in closures and validates tool names against ``ToolNode.tools_by_name``. Client
tools arrive per-request in ``RunAgentInput.tools``, so we inject them into those
structures and relax LangChain's dynamic-tool guard when needed. We also replace the
thread's message list with a sanitized full transcript (not incremental deltas) so
OpenAI and LangGraph never see ``tool`` messages without a matching assistant
``tool_calls`` block.
"""

import inspect
import logging
import traceback
from typing import Any, Dict, List

from langchain_core.messages import RemoveMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph.message import REMOVE_ALL_MESSAGES
from langgraph.graph.state import CompiledStateGraph

from ag_ui.core import RunAgentInput
from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE
from pyagentspec.adapters.langgraph._langgraphconverter import AgentSpecToLangGraphConverter
from pyagentspec.property import Property

logger = logging.getLogger("ag_ui_agentspec.tracing")

_CLIENT_TOOL_CONVERTER = AgentSpecToLangGraphConverter()


def _passthrough_wrap_tool_call(request: Any, handler: Any) -> Any:
    """Sync no-op middleware: LangChain only skips strict tool registration when a wrap is set."""
    return handler(request)


async def _passthrough_awrap_tool_call(request: Any, handler: Any) -> Any:
    """Async variant of :func:`_passthrough_wrap_tool_call` for async agent paths."""
    return await handler(request)


def _get_create_agent_get_bound_model(agent: CompiledStateGraph) -> Any:
    """Reach ``_get_bound_model`` inside create_agent's nested closures from the compiled graph."""
    m = agent.nodes.get("model")
    if m is None:
        return None
    rc = m.bound
    amodel = getattr(rc, "afunc", None) or getattr(rc, "func", None)
    if amodel is None:
        return None
    try:
        # create_agent nests model execution in closures; we need the inner _get_bound_model
        # to patch wrap_tool_call_wrapper without forking LangChain.
        ex = inspect.getclosurevars(amodel).nonlocals.get("_execute_model_async")
        if ex is None:
            return None
        return inspect.getclosurevars(ex).nonlocals.get("_get_bound_model")
    except (TypeError, ValueError):
        return None


def _ensure_dynamic_tool_validation_skipped(agent: CompiledStateGraph) -> None:
    """Install a passthrough wrap so LangChain accepts tools not pre-registered on ``ToolNode``.

    ``_get_bound_model`` compares ``request.tools`` to ``tool_node.tools_by_name`` unless
    ``wrap_tool_call_wrapper`` (or the async equivalent) is set. CopilotKit registers
    client tools at runtime, so we set those cells to our no-op wrappers when absent.
    """
    gb = _get_create_agent_get_bound_model(agent)
    if gb is None or gb.__closure__ is None or gb.__code__ is None:
        return
    freevars = gb.__code__.co_freevars
    closure = gb.__closure__
    nl = inspect.getclosurevars(gb).nonlocals
    if nl.get("wrap_tool_call_wrapper") is not None or nl.get("awrap_tool_call_wrapper") is not None:
        return
    if "wrap_tool_call_wrapper" in freevars:
        closure[freevars.index("wrap_tool_call_wrapper")].cell_contents = _passthrough_wrap_tool_call
    elif "awrap_tool_call_wrapper" in freevars:
        closure[freevars.index("awrap_tool_call_wrapper")].cell_contents = _passthrough_awrap_tool_call


def _properties_from_run_agent_tool_parameters(tool: Any) -> List[Property]:
    """Turn AG-UI JSON Schema parameters into pyagentspec ``Property`` for ``ClientTool``."""
    params = tool.parameters
    if not isinstance(params, dict) or not params.get("properties"):
        return []
    out: List[Property] = []
    for prop_name, prop_schema in params["properties"].items():
        if not isinstance(prop_schema, dict):
            prop_schema = {"type": "string", "description": str(prop_schema)}
        js = {**prop_schema}
        js.setdefault("title", prop_name)
        out.append(Property(title=prop_name, json_schema=js))
    return out


def _build_frontend_tools(input_data: RunAgentInput) -> list:
    """Build LangGraph-callable tools from ``RunAgentInput.tools`` (same path as spec client tools)."""
    if not input_data.tools:
        return []
    from pyagentspec.tools import ClientTool

    tools = []
    for t in input_data.tools:
        ct = ClientTool(
            name=t.name,
            description=t.description or "",
            inputs=_properties_from_run_agent_tool_parameters(t),
        )
        tools.append(_CLIENT_TOOL_CONVERTER._client_tool_convert_to_langgraph(ct))
    return tools


def _inject_frontend_tools_into_create_agent(agent: CompiledStateGraph, extra_tools: list) -> None:
    """Append per-request tools to create_agent's ``default_tools`` and ``ToolNode.tools_by_name``.

    Re-binding the model is not enough: the prebuilt agent reads tool lists from closure
    state and from the tool node map. After injection we ensure dynamic-tool validation
    is skipped so new names are not rejected.
    """
    if not extra_tools:
        return

    from langgraph.prebuilt.tool_node import ToolNode, _get_all_injected_args

    m = agent.nodes.get("model")
    if m is None:
        return
    rc = m.bound
    amodel = getattr(rc, "afunc", None) or getattr(rc, "func", None)
    if amodel is None:
        return
    try:
        default_tools = inspect.getclosurevars(amodel).nonlocals.get("default_tools")
    except (TypeError, ValueError):
        return
    if default_tools is None:
        return

    registered = {getattr(t, "name", None) for t in default_tools}
    tw = agent.nodes.get("tools")
    tool_node = tw.bound if tw is not None and isinstance(tw.bound, ToolNode) else None

    for t in extra_tools:
        name = getattr(t, "name", None)
        if not name or name in registered:
            continue
        default_tools.append(t)
        registered.add(name)
        if tool_node is not None:
            tool_node.tools_by_name[name] = t
            tool_node._injected_args[name] = _get_all_injected_args(t)

    _ensure_dynamic_tool_validation_skipped(agent)


async def run_langgraph_agent(agent: CompiledStateGraph, input_data: RunAgentInput) -> None:
    """Stream the graph for this thread: reset messages to the client transcript, inject tools, trace.

    Uses ``RemoveMessage(REMOVE_ALL_MESSAGES)`` plus the full sanitized history so each
    run replaces checkpoint state instead of appending an incremental slice (which can
    leave orphan ``tool`` rows and break the chat API). Events go through ``EVENT_QUEUE``
    for the agentspec tracer.
    """
    sanitized = _messages_for_langgraph_chat(prepare_langgraph_agent_inputs(input_data))
    input_messages: list = (
        [RemoveMessage(id=REMOVE_ALL_MESSAGES), *sanitized] if sanitized else []
    )
    config = RunnableConfig({"configurable": {"thread_id": input_data.thread_id}})

    if input_data.tools:
        ft = _build_frontend_tools(input_data)
        if ft:
            _inject_frontend_tools_into_create_agent(agent, ft)
        else:
            _ensure_dynamic_tool_validation_skipped(agent)

    current_queue = EVENT_QUEUE.get()
    token = EVENT_QUEUE.set(current_queue)
    try:
        async for _ in agent.astream({"messages": input_messages}, stream_mode="messages", config=config):
            pass
    except Exception as e:
        logger.exception(
            "LangGraph agent crashed with error: %s%s",
            repr(e),
            traceback.format_exc(),
        )
        raise RuntimeError(f"LangGraph agent crashed with error: {repr(e)}\n\nTraceback: {traceback.format_exc()}")
    finally:
        EVENT_QUEUE.reset(token)

def prepare_langgraph_agent_inputs(input_data: RunAgentInput) -> List[Dict[str, Any]]:
    messages = input_data.messages
    if not messages:
        return []
    messages_to_return = []
    for m in messages:
        m_dict = m.model_dump()
        if m_dict["role"] in {"user", "assistant"} and "name" in m_dict:
            del m_dict["name"]
        if m_dict["role"] == "tool" and "error" in m_dict:
            del m_dict["error"]
        if m_dict["role"] == "assistant" and m_dict["content"] is None:
            m_dict["content"] = ""
        messages_to_return.append(m_dict)
    return messages_to_return

def _messages_for_langgraph_chat(messages: list[dict]) -> list[dict]:
    """Keep only roles the chat model understands, then drop tool rows without a parent tool_calls."""
    allowed = {"user", "assistant", "system", "developer", "tool"}
    filtered = [m for m in messages if m.get("role") in allowed]
    return _drop_orphan_tool_messages(filtered)


def _drop_orphan_tool_messages(messages: list[dict]) -> list[dict]:
    """Remove ``tool`` messages whose ``tool_call_id`` is not in the latest assistant tool_calls.

    Providers require every tool result to follow an assistant message that requested it;
    incremental history or checkpoint merges can otherwise produce 400s.
    """
    kept: list[dict] = []
    pending: set[str] = set()

    for m in messages:
        role = m.get("role")
        if role in ("assistant", "ai"):
            kept.append(m)
            pending = {
                str(tc["id"])
                for tc in (m.get("tool_calls") or [])
                if isinstance(tc, dict) and tc.get("id")
            }
            continue
        if role == "tool":
            tcid = str(m["tool_call_id"]) if m.get("tool_call_id") is not None else ""
            if tcid and tcid in pending:
                kept.append(m)
                pending.discard(tcid)
            else:
                logger.warning("Dropping orphan tool message id=%s", m.get("id"))
            continue
        kept.append(m)
        pending = set()

    return kept
