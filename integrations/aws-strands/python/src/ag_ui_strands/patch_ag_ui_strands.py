#!/usr/bin/env python3.12
"""Build-time patch: fix ag_ui_strands for correct frontend/backend parallel tool calls.

Applied at build time as root (the runtime user can't write site-packages).
Idempotent; exits non-zero if any expected anchor is missing so the build fails
loudly (a sign ag_ui_strands changed and the anchors below need updating).
TODO: remove each fix once addressed upstream in ag_ui_strands.

Fixes (all in ag_ui_strands/agent.py):

  frontend-id : Frontend tools otherwise get a per-run random UUID that is never
                persisted, so on restore the client's id can't be matched. Reuse
                Strands' stable tool id instead.

  #1 halt-break : On a frontend-tool halt the main loop did `continue`, which only
                stops FORWARDING events (mute) but leaves the Strands event loop
                running — it makes another full Bedrock call and hangs the run.
                `break` lets the existing `agent_stream.aclose()` terminate Strands.

  #2 keep-message : Setting halt discarded the ENTIRE tool-result message with a
                premature `continue`. That message packs results for ALL tools in
                the turn, so a parallel BACKEND tool's real result was dropped too.
                Drop the `continue`; the loop below already skips frontend-tool
                results and emits backend-tool results.

  #3 defer-handoff : The frontend tool's ToolCallEnd (the "execute this now" signal)
                was emitted BEFORE this turn's backend tools finished, so the client
                dispatched its follow-up run while the current run was still busy ->
                ConcurrencyException. Buffer the frontend ToolCallEnd and flush it
                only after the backend results arrive. (3a init, 3b buffer, 3c flush)

  #4 normalize-history : The client replays prior turns as SEPARATE messages (one
                assistant per toolUse, one user per toolResult, sometimes with text
                interleaved). Bedrock requires all toolUse of a turn in ONE assistant
                message and all matching toolResult in the IMMEDIATELY following user
                message. Normalize the rebuilt Strands history so the 2nd call in a
                conversation no longer fails with
                "toolResult blocks at messages.N exceeds toolUse blocks of previous turn".
"""
import pathlib
import sys


# --- frontend-id: reuse Strands stable tool id for frontend tools ---
_OLD_ID = (
    "                        elif is_frontend_tool:\n"
    "                            # Generate new UUID for frontend tools\n"
    "                            tool_use_id = str(uuid.uuid4())"
)
_NEW_ID = (
    "                        elif is_frontend_tool:\n"
    "                            # PATCHED: reuse Strands tool id (stable across runs)\n"
    "                            tool_use_id = strands_tool_id or str(uuid.uuid4())"
)


# --- Fix #1: halt should BREAK (brake) not CONTINUE (mute only) ---
_OLD_1 = (
    "                    # If we've halted, consume remaining events silently to allow proper cleanup\n"
    "                    if halt_event_stream:\n"
    "                        continue"
)
_NEW_1 = (
    "                    # PATCHED: halt must BREAK out of the loop (brake), not just\n"
    "                    # continue (mute). continue kept the Strands event loop alive,\n"
    "                    # causing an extra Bedrock call and a hung Run. break lets the\n"
    "                    # existing agent_stream.aclose() cleanup terminate Strands.\n"
    "                    if halt_event_stream:\n"
    "                        break"
)


# --- Fix #2: don't discard the whole tool-result message when setting halt ---
_OLD_2 = (
    '                    elif "message" in event and event["message"].get("role") == "user":\n'
    "                        if pending_halt:\n"
    "                            halt_event_stream = True\n"
    "                            continue"
)
_NEW_2 = (
    '                    elif "message" in event and event["message"].get("role") == "user":\n'
    "                        if pending_halt:\n"
    "                            # PATCHED: set halt but DO NOT discard this message. It\n"
    "                            # packs results for ALL tools in the turn; the loop below\n"
    "                            # skips frontend-tool results and emits backend-tool\n"
    "                            # results. The next loop-top `break` (fix #1) then stops\n"
    "                            # the stream after backend results are flushed.\n"
    "                            halt_event_stream = True"
)


# --- Fix #3a: init a buffer for deferred frontend-tool ToolCallEnd events ---
_OLD_3A = (
    "            halt_event_stream = False\n"
    "            pending_halt = False"
)
_NEW_3A = (
    "            halt_event_stream = False\n"
    "            pending_halt = False\n"
    "            # PATCHED (defer hand-off): frontend-tool ToolCallEnd ids buffered here\n"
    "            # so the client's 'execute this frontend tool' signal is delayed until\n"
    "            # AFTER this turn's backend tool results have been emitted. Prevents the\n"
    "            # client dispatching its follow-up run (tool result) before the current\n"
    "            # run finishes -> reduces the ConcurrencyException race window.\n"
    "            deferred_frontend_tool_ends = []"
)


# --- Fix #3b: at the ToolCallEnd (use_streaming path), buffer it for frontend tools ---
_OLD_3B = (
    "                                    yield ToolCallEndEvent(\n"
    "                                        type=EventType.TOOL_CALL_END,\n"
    "                                        tool_call_id=tool_use_id,\n"
    "                                    )\n"
    "\n"
    "                                    if self._will_emit_tool_snapshot(behavior, emit_snapshots):"
)
_NEW_3B = (
    "                                    # PATCHED (defer hand-off): for frontend tools,\n"
    "                                    # buffer the ToolCallEnd instead of emitting now.\n"
    "                                    # It is flushed after this turn's backend results\n"
    "                                    # (see Fix #3c). Backend tools emit immediately.\n"
    "                                    if is_frontend_tool and not (\n"
    "                                        behavior\n"
    "                                        and behavior.continue_after_frontend_call\n"
    "                                    ):\n"
    "                                        deferred_frontend_tool_ends.append(tool_use_id)\n"
    "                                    else:\n"
    "                                        yield ToolCallEndEvent(\n"
    "                                            type=EventType.TOOL_CALL_END,\n"
    "                                            tool_call_id=tool_use_id,\n"
    "                                        )\n"
    "\n"
    "                                    if self._will_emit_tool_snapshot(behavior, emit_snapshots):"
)


# --- Fix #3c: flush buffered frontend ToolCallEnd after backend results emitted ---
_OLD_3C = (
    "                        if pending_halt:\n"
    "                            # PATCHED: set halt but DO NOT discard this message. It\n"
    "                            # packs results for ALL tools in the turn; the loop below\n"
    "                            # skips frontend-tool results and emits backend-tool\n"
    "                            # results. The next loop-top `break` (fix #1) then stops\n"
    "                            # the stream after backend results are flushed.\n"
    "                            halt_event_stream = True"
)
_NEW_3C = (
    "                        if pending_halt:\n"
    "                            # PATCHED: set halt but DO NOT discard this message. It\n"
    "                            # packs results for ALL tools in the turn; the loop below\n"
    "                            # skips frontend-tool results and emits backend-tool\n"
    "                            # results. The next loop-top `break` (fix #1) then stops\n"
    "                            # the stream after backend results are flushed.\n"
    "                            halt_event_stream = True\n"
    "                            # PATCHED (defer hand-off): backend results for this turn\n"
    "                            # have arrived in this message; NOW flush the buffered\n"
    "                            # frontend-tool ToolCallEnd(s) so the client only starts\n"
    "                            # executing the frontend tool (and dispatching its\n"
    "                            # follow-up run) after backend work is done.\n"
    "                            for _fe_tool_use_id in deferred_frontend_tool_ends:\n"
    "                                yield ToolCallEndEvent(\n"
    "                                    type=EventType.TOOL_CALL_END,\n"
    "                                    tool_call_id=_fe_tool_use_id,\n"
    "                                )\n"
    "                            deferred_frontend_tool_ends = []"
)


# --- Fix #4: normalize Strands history for Bedrock toolUse/toolResult pairing ---
_OLD_4 = (
    '        elif role == "tool":\n'
    '            out.append(\n'
    '                {\n'
    '                    "role": "user",\n'
    '                    "content": [\n'
    '                        {\n'
    '                            "toolResult": {\n'
    '                                "toolUseId": getattr(msg, "tool_call_id", "") or "",\n'
    '                                "content": [{"text": _coerce_text(msg.content)}],\n'
    '                                "status": "success",\n'
    '                            }\n'
    '                        }\n'
    '                    ],\n'
    '                }\n'
    '            )\n'
    "    return out"
)
_NEW_4 = (
    '        elif role == "tool":\n'
    '            out.append(\n'
    '                {\n'
    '                    "role": "user",\n'
    '                    "content": [\n'
    '                        {\n'
    '                            "toolResult": {\n'
    '                                "toolUseId": getattr(msg, "tool_call_id", "") or "",\n'
    '                                "content": [{"text": _coerce_text(msg.content)}],\n'
    '                                "status": "success",\n'
    '                            }\n'
    '                        }\n'
    '                    ],\n'
    '                }\n'
    '            )\n'
    "    # PATCHED (Fix #4): normalize so Bedrock's toolUse/toolResult pairing holds.\n"
    "    return _normalize_tool_turns(out)\n"
    "\n"
    "\n"
    "def _is_tooluse_only_assistant(m):\n"
    '    return (\n'
    '        m.get("role") == "assistant"\n'
    '        and m.get("content")\n'
    '        and all("toolUse" in b for b in m["content"])\n'
    '    )\n'
    "\n"
    "\n"
    "def _is_toolresult_only_user(m):\n"
    '    return (\n'
    '        m.get("role") == "user"\n'
    '        and m.get("content")\n'
    '        and all("toolResult" in b for b in m["content"])\n'
    '    )\n'
    "\n"
    "\n"
    "def _normalize_tool_turns(msgs):\n"
    '    """Merge same-turn toolUse into one assistant msg and their toolResults\n'
    "    into the immediately following user msg, dropping any messages wedged\n"
    "    between a toolUse turn and its toolResults so Bedrock accepts the history.\n"
    '    """\n'
    "    out = []\n"
    "    i = 0\n"
    "    n = len(msgs)\n"
    "    while i < n:\n"
    "        m = msgs[i]\n"
    "        if _is_tooluse_only_assistant(m):\n"
    "            # Collect consecutive toolUse-only assistant messages into one.\n"
    "            merged_tooluse = list(m[\"content\"])\n"
    "            j = i + 1\n"
    "            while j < n and _is_tooluse_only_assistant(msgs[j]):\n"
    "                merged_tooluse.extend(msgs[j][\"content\"])\n"
    "                j += 1\n"
    "            tooluse_ids = [b[\"toolUse\"][\"toolUseId\"] for b in merged_tooluse]\n"
    "            # Scan the rest of the conversation for the matching toolResults,\n"
    "            # collecting them (they may be split across messages / interleaved\n"
    "            # with text). Non-matching messages after the results are kept.\n"
    "            results_by_id = {}\n"
    "            leftover = []\n"
    "            k = j\n"
    "            while k < n:\n"
    "                mk = msgs[k]\n"
    "                if _is_toolresult_only_user(mk):\n"
    "                    for b in mk[\"content\"]:\n"
    "                        rid = b[\"toolResult\"].get(\"toolUseId\")\n"
    "                        if rid in tooluse_ids and rid not in results_by_id:\n"
    "                            results_by_id[rid] = b\n"
    "                        else:\n"
    "                            leftover.append({\"role\": \"user\", \"content\": [b]})\n"
    "                else:\n"
    "                    leftover.append(mk)\n"
    "                k += 1\n"
    "                if len(results_by_id) == len(tooluse_ids):\n"
    "                    leftover.extend(msgs[k:])\n"
    "                    break\n"
    "            # Emit merged assistant(toolUse) + merged user(toolResult) adjacently.\n"
    "            out.append({\"role\": \"assistant\", \"content\": merged_tooluse})\n"
    "            ordered = [results_by_id[tid] for tid in tooluse_ids if tid in results_by_id]\n"
    "            if ordered:\n"
    "                out.append({\"role\": \"user\", \"content\": ordered})\n"
    "            out.extend(_normalize_tool_turns(leftover))\n"
    "            return out\n"
    "        else:\n"
    "            out.append(m)\n"
    "            i += 1\n"
    "    return out\n"
)


# Ordered list of (marker_present_in_new, old_anchor, new_text, label).
# `marker` lets us detect an already-applied fix and skip it (idempotent).
_FIXES = [
    ("# PATCHED: reuse Strands tool id",              _OLD_ID, _NEW_ID, "frontend-id"),
    ("halt must BREAK",                                _OLD_1,  _NEW_1,  "#1 halt-break"),
    ("DO NOT discard this message",                    _OLD_2,  _NEW_2,  "#2 keep-message"),
    ("deferred_frontend_tool_ends = []",               _OLD_3A, _NEW_3A, "#3a defer-init"),
    ("defer hand-off): for frontend tools",            _OLD_3B, _NEW_3B, "#3b defer-buffer"),
    ("NOW flush the buffered",                         _OLD_3C, _NEW_3C, "#3c defer-flush"),
    ("_normalize_tool_turns",                          _OLD_4,  _NEW_4,  "#4 normalize-history"),
]


def main() -> int:
    candidates = []
    for d in sys.path:
        try:
            agent = pathlib.Path(d) / "ag_ui_strands" / "agent.py"
        except Exception:
            continue
        if agent.is_file() and agent not in candidates:
            candidates.append(agent)

    if not candidates:
        print(
            "[patch_ag_ui_strands] ERROR: ag_ui_strands/agent.py not found on sys.path",
            file=sys.stderr,
        )
        return 1

    agent = candidates[0]
    src = agent.read_text()

    applied = []
    for marker, old, new, label in _FIXES:
        if marker in src:
            # Already applied (idempotent).
            continue
        if old not in src:
            print(
                f"[patch_ag_ui_strands] ERROR: anchor for '{label}' not found in "
                f"{agent}. ag_ui_strands may have changed — update this fix's _OLD.",
                file=sys.stderr,
            )
            return 1
        src = src.replace(old, new, 1)
        applied.append(label)

    agent.write_text(src)

    # Drop stale bytecode so the patched source is what gets imported.
    pycache = agent.parent / "__pycache__"
    if pycache.is_dir():
        for pyc in pycache.glob("agent.*.pyc"):
            try:
                pyc.unlink()
            except Exception:
                pass

    # Verify every fix's marker is present.
    check = agent.read_text()
    missing = [label for marker, _o, _n, label in _FIXES if marker not in check]
    if missing:
        print(
            f"[patch_ag_ui_strands] ERROR: patch verification failed for {agent}. "
            f"Missing: {missing}",
            file=sys.stderr,
        )
        return 1

    if applied:
        print(f"[patch_ag_ui_strands] Applied fixes {applied} to {agent}")
    else:
        print(f"[patch_ag_ui_strands] already patched (all fixes): {agent}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
