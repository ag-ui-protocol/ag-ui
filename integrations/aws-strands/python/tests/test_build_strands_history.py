"""Regression tests for #1847.

`_build_strands_history` converts AG-UI messages to Strands/Bedrock native
messages. For parallel tool calls (one assistant turn with multiple toolUse
blocks), Amazon Bedrock Converse requires all matching toolResult blocks to
appear in a SINGLE following user message. The old code emitted one user
message per AG-UI tool message, which Bedrock rejects.
"""

from types import SimpleNamespace

from ag_ui_strands.agent import _build_strands_history


def _tc(tc_id, name, args="{}"):
    return SimpleNamespace(id=tc_id, function={"name": name, "arguments": args})


def _tool_result_messages(out):
    return [
        m
        for m in out
        if m["role"] == "user"
        and m["content"]
        and all("toolResult" in b for b in m["content"])
    ]


def test_parallel_tool_results_bundled_into_one_user_message():
    msgs = [
        SimpleNamespace(role="user", content="hi"),
        SimpleNamespace(
            role="assistant", content="", tool_calls=[_tc("a", "f1"), _tc("b", "f2")]
        ),
        SimpleNamespace(role="tool", tool_call_id="a", content="r1"),
        SimpleNamespace(role="tool", tool_call_id="b", content="r2"),
    ]
    out = _build_strands_history(msgs)

    tool_msgs = _tool_result_messages(out)
    # Bedrock requires ONE user message carrying both toolResults.
    assert len(tool_msgs) == 1, f"expected 1 bundled tool-result message, got {len(tool_msgs)}"
    assert len(tool_msgs[0]["content"]) == 2
    ids = [b["toolResult"]["toolUseId"] for b in tool_msgs[0]["content"]]
    assert ids == ["a", "b"]


def test_single_tool_result_still_one_message():
    msgs = [
        SimpleNamespace(role="assistant", content="", tool_calls=[_tc("a", "f1")]),
        SimpleNamespace(role="tool", tool_call_id="a", content="r1"),
    ]
    out = _build_strands_history(msgs)
    tool_msgs = _tool_result_messages(out)
    assert len(tool_msgs) == 1
    assert len(tool_msgs[0]["content"]) == 1
    assert tool_msgs[0]["content"][0]["toolResult"]["toolUseId"] == "a"


def test_separate_turns_not_merged():
    # Tool results from two distinct assistant turns must NOT collapse together;
    # a user message between them is a turn boundary.
    msgs = [
        SimpleNamespace(role="assistant", content="", tool_calls=[_tc("a", "f1")]),
        SimpleNamespace(role="tool", tool_call_id="a", content="r1"),
        SimpleNamespace(role="user", content="next"),
        SimpleNamespace(role="assistant", content="", tool_calls=[_tc("b", "f2")]),
        SimpleNamespace(role="tool", tool_call_id="b", content="r2"),
    ]
    out = _build_strands_history(msgs)
    tool_msgs = _tool_result_messages(out)
    assert len(tool_msgs) == 2
    assert [len(m["content"]) for m in tool_msgs] == [1, 1]


def test_ordering_preserved():
    msgs = [
        SimpleNamespace(role="user", content="hi"),
        SimpleNamespace(
            role="assistant", content="", tool_calls=[_tc("a", "f1"), _tc("b", "f2")]
        ),
        SimpleNamespace(role="tool", tool_call_id="a", content="r1"),
        SimpleNamespace(role="tool", tool_call_id="b", content="r2"),
    ]
    out = _build_strands_history(msgs)
    roles = [m["role"] for m in out]
    # user, assistant(toolUse), user(bundled toolResults)
    assert roles == ["user", "assistant", "user"]
