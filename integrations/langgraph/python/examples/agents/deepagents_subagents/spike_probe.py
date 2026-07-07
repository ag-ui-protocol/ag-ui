"""SPIKE probe: how does a deepagents `task`-delegated subagent surface in the
LangGraph event stream consumed by ag_ui_langgraph?

Run:
    <spikeenv>/bin/python spike_probe.py

Uses deterministic FakeMessagesListChatModel instances so NO live LLM key is
needed. The main agent emits exactly one `task` tool call (delegating to the
"researcher" subagent) then a final answer; the subagent emits a single final
message.

This is throwaway investigation code (Task 1 of the subagent-attribution plan).
"""

import asyncio
import json

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage

from deepagents import create_deep_agent


class ToolCallingFakeModel(FakeMessagesListChatModel):
    """FakeMessagesListChatModel that tolerates bind_tools (returns self, ignoring
    the tools) so it can be used inside create_agent, which always binds tools."""

    def bind_tools(self, tools, **kwargs):  # noqa: ARG002
        return self


def main_model() -> ToolCallingFakeModel:
    """Main/supervisor model: first turn -> `task` delegation, second turn -> final."""
    return ToolCallingFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "task",
                        "args": {
                            "description": "Research the capital of France.",
                            "subagent_type": "researcher",
                        },
                        "id": "call_task_1",
                    }
                ],
            ),
            AIMessage(content="Done: the capital of France is Paris."),
        ]
    )


def subagent_model() -> ToolCallingFakeModel:
    """Researcher subagent model: single final answer, no tool calls."""
    return ToolCallingFakeModel(
        responses=[
            AIMessage(content="The capital of France is Paris."),
        ]
    )


def build_agent():
    researcher = {
        "name": "researcher",
        "description": "Researches factual questions and returns a concise answer.",
        "system_prompt": "You are a researcher. Answer the question concisely.",
        "model": subagent_model(),
        "tools": [],
    }
    return create_deep_agent(
        model=main_model(),
        tools=[],
        system_prompt="You are a supervisor. Delegate research to the researcher subagent.",
        subagents=[researcher],
    )


def short(v, n=80):
    s = repr(v)
    return s if len(s) <= n else s[:n] + "..."


async def run():
    agent = build_agent()
    inp = {"messages": [HumanMessage(content="What is the capital of France?")]}

    print("=" * 100)
    print("RAW astream_events (version=v2) — every event")
    print("=" * 100)
    header = f"{'idx':>3} | {'event':<28} | {'ns':<45} | {'node':<18} | run_id"
    print(header)
    print("-" * len(header))

    idx = 0
    seen_ns = []
    for_notes = []
    async for ev in agent.astream_events(inp, version="v2"):
        idx += 1
        etype = ev.get("event", "")
        md = ev.get("metadata") or {}
        ns = md.get("langgraph_checkpoint_ns", None)
        node = md.get("langgraph_node", None)
        run_id = ev.get("run_id", "")
        name = ev.get("name", "")

        if ns is not None and ns not in seen_ns:
            seen_ns.append(ns)

        # Hunt for subagent/task identifiers anywhere useful.
        extras = {}
        for key in ("ls_agent_type", "langgraph_step", "langgraph_triggers",
                    "lc_agent_name", "subagent", "subagent_type", "task"):
            if key in md:
                extras[key] = md[key]
        # tool call args (where subagent_type actually lives)
        data = ev.get("data") or {}
        if etype == "on_tool_start" and name == "task":
            extras["tool_input"] = data.get("input")
        if etype == "on_chat_model_end":
            out = data.get("output")
            tcs = getattr(out, "tool_calls", None)
            if tcs:
                extras["tool_calls"] = [{"name": t.get("name"), "args": t.get("args")} for t in tcs]

        print(f"{idx:>3} | {etype:<28} | {str(ns):<45} | {str(node):<18} | {short(run_id,12)}"
              + (f"  | name={name}" if name else "")
              + (f"  | {short(extras,300)}" if extras else ""))

        for_notes.append({
            "idx": idx, "event": etype, "ns": ns, "node": node,
            "run_id": run_id, "name": name, "extras": extras,
        })

    print("\n" + "=" * 100)
    print("DISTINCT checkpoint_ns VALUES SEEN (in first-seen order):")
    for i, n in enumerate(seen_ns):
        print(f"  [{i}] {n!r}")
    print("=" * 100)

    # dump full trace for the notes file
    with open("spike_trace.json", "w") as f:
        json.dump(for_notes, f, indent=2, default=str)
    print("full trace written to spike_trace.json")


if __name__ == "__main__":
    asyncio.run(run())
