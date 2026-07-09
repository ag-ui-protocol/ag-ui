# MESSAGES_SNAPSHOT drops streamed subagent messages — finding & fix

Demo temporarily reduced to a SINGLE subagent (`market_researcher`) to isolate
the mechanism (see `agent.py`). Wire captured by POSTing a minimal
`RunAgentInput` to the FastAPI dojo endpoint `/agent/deepagents_subagents`
(`LANGGRAPH_FAST_API=true uvicorn examples.agents.dojo:app --port 8137`).

User prompt: *"Should I build a subscription box for artisanal coffee?"*

## Part 1 — CONFIRMED: the snapshot drops the subagent message

Event ordering (RAW / TEXT_MESSAGE_CONTENT / TOOL_CALL_ARGS spam elided):

```
RUN_STARTED
TOOL_CALL_START name=task subagentId=None            # supervisor delegates via `task`
STATE_SNAPSHOT
MESSAGES_SNAPSHOT  [2 msgs]                           # mid-run (before subagent text)
SUBAGENT_STARTED subagent_id=tools:fdee8e7b... name=market_researcher
TEXT_MESSAGE_START msgId=lc_run--019f3d80-1da8-... role=assistant subagentId=tools:fdee8e7b...   # <-- subagent's streamed assistant message
... (subagent TEXT_MESSAGE_CONTENT stream) ...
TEXT_MESSAGE_END msgId=lc_run--019f3d80-1da8-...
TOOL_CALL_RESULT                                     # task result folded into main state
TEXT_MESSAGE_START msgId=lc_run--019f3d80-337b-... role=assistant subagentId=None   # supervisor synthesis
STATE_SNAPSHOT
MESSAGES_SNAPSHOT  [4 msgs]                           # FINAL — see below
SUBAGENT_FINISHED subagent_id=tools:fdee8e7b...
RUN_FINISHED
```

- `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` **do** carry
  `subagentId=tools:fdee8e7b...` for the subagent (confirmed).
- The subagent's streamed assistant message id is
  `lc_run--019f3d80-1da8-79c3-9c10-9678dcc4dda6`.
- The FINAL `MESSAGES_SNAPSHOT` (emitted AFTER the subagent stream, index 1402
  vs. the subagent START at index 171) contained only 4 messages, and the
  streamed subagent message was **absent** — all four carry `subagentId=None`:

```
role=user      id=m1                       subagentId=None  "Should I build a subscription box for ar…"
role=assistant id=lc_run--019f3d7f-f7d2-…  subagentId=None  ""            # supervisor tool-call msg
role=tool      id=81807adb-…               subagentId=None  "The market for a subscription box servic…"  # task result
role=assistant id=lc_run--019f3d80-337b-…  subagentId=None  "Building a subscription box for artisana…"  # synthesis
```

Because the snapshot is built from the MAIN (supervisor) graph state — which
holds only the `task` tool RESULT, not the subagent's internal assistant
message — and it arrives after the streamed subagent message and REPLACES the
client's message list, the streamed subagent message (with `subagentId`) is
wiped. So the subagentId marker never persists in `agent.messages`. **Mechanism
confirmed.**

## Part 2/3 — fix & verification

Fix (in `ag_ui_langgraph/agent.py`): accumulate subagent-attributed assistant
messages as they stream (keyed by message id, on
`active_run["subagent_messages"]`, populated at the `_dispatch_event`
chokepoint), then merge them — preserving `subagent_id` — into the messages
list built by `get_state_and_messages_snapshots`. No-op when no subagent
messages were captured, so normal runs and the declared-`subgraphs` demo
produce an identical snapshot.

Re-captured wire — the FINAL `MESSAGES_SNAPSHOT` now CONTAINS the
subagent-attributed message (5th entry, `subagentId` set):

```
role=user      id=m1                       subagentId=None                       "Should I build a subscription box for artisanal coffee?"
role=assistant id=lc_run--019f3d83-7f9a-…  subagentId=None                       ""            # supervisor tool-call msg
role=tool      id=b567bff6-…               subagentId=None                       "The market for artisanal coffee subscriptions is curren…"  # task result
role=assistant id=lc_run--019f3d84-1735-…  subagentId=None                       "Building a subscription box for artisanal coffee appear…"  # synthesis
role=assistant id=lc_run--019f3d84-09c9-…  subagentId=tools:c80962d9-2948-…      "The market for artisanal coffee subscriptions is curren…"  # <-- subagent message, attributed
```

The four main-graph messages are unchanged; the subagent message is appended
with its `subagentId`, so the client applies it and the frontend can read
`message.subagentId`.
