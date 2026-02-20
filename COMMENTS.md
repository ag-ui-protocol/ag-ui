# Code Review Comments

## Middleware — `injectA2UITool` + auto-detection

### 1. False positive risk in auto-detection
Any tool that returns JSON with a key like `surfaceUpdate`, `beginRendering`, or `dataModelUpdate` will be treated as A2UI. There's no opt-out per tool. In practice this is probably fine since those keys are very specific, but there's no escape hatch if a tool legitimately returns JSON with one of those keys.

### 2. `tryParseA2UIOperations` accepts mixed arrays
If an array has 10 objects and only 1 has a valid A2UI key, all 10 are treated as operations. The `parsed.some(...)` check should probably be `parsed.every(...)` — or at least filter to only valid operations.

### 3. Tool result content sends raw operations back to the LLM
The tool result changed from `{ success: true, surfacesRendered: [...] }` to `JSON.stringify(operations)`. This sends raw A2UI JSON back to the LLM as the tool result. The raw operations can be large (the login form example is ~40 lines of JSON). The old response was compact and informative. This change makes the LLM waste tokens re-reading what it just produced. Consider a short summary like before, or at least a truncated version.

### 4. No `LOG_A2UI_EVENT_TOOL_NAME` exclusion in auto-detect
The `a2uiToolCallIds` set only tracks `SEND_A2UI_TOOL_NAME`. If `log_a2ui_event` tool results ever contain A2UI-like JSON, they'd be double-processed too. Low risk but inconsistent.

## Dojo + agent

### 5. Inline styles in `page.tsx`
The toggle UI uses inline `style={{...}}` objects. The rest of the page uses Tailwind classes. Should be consistent — either all Tailwind or extract a CSS class in `style.css`.

### 6. `LOGIN_FORM_A2UI` is a large hardcoded constant
30 lines sitting at module level in `agent.py`. For a demo this is fine, but if this file grows with more demo tools, it'll become hard to read. Consider moving sample payloads to a separate file or at least to the bottom of the module.

### 7. `route_after_chat` is fragile with parallel tool calls
The routing only checks backend tool names. If the LLM calls both a backend and frontend tool in the same message, ToolNode would error on the unrecognized frontend tool. Currently safe because `parallel_tool_calls=False`, but fragile if that constraint is ever removed.

### 8. System prompt mentions `send_a2ui_json_to_client` unconditionally
`SYSTEM_PROMPT` always says "use the send_a2ui_json_to_client tool" but that tool is only available when `injectA2UITool: true`. When using the `a2ui_chat` agent without injection (the langgraph-fastapi default), the LLM is told about a tool it doesn't have.

## Client SDK — edit-based merge

### 9. Activity messages can drift from their semantic position
The merge preserves activity messages in their current array position but only keeps non-activity messages that exist in the snapshot. If the message before an activity gets removed by the snapshot, the activity stays but now sits next to a different message. This is probably the best you can do without anchor metadata, but it's a known limitation.

### 10. `applyMutation({ messages })` is called twice
Once after subscriber mutations, once after the merge. Subscribers see the old messages first, then get overwritten. If subscriber mutations to messages are expected to survive the merge, they won't.

### 11. No guard for activity messages with duplicate IDs
If two activity messages end up with the same ID, the `existingIds` set would skip the second one during the append step. Edge case, but theoretically possible if surfaces are recreated.
