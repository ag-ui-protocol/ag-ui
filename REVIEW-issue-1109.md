# Review: Issue #1109 and PR #1110

## Issue #1109: `adk_events_to_messages` leaks thought parts into AssistantMessage content on session reload

### Issue Validity: VALID

The bug is real and well-documented. Here is the analysis:

**Root cause:** The `adk_events_to_messages()` function in `event_translator.py:997-1081` iterates over all parts in an ADK event and blindly concatenates any part with a `.text` attribute into a single `text_content` string (lines 1027-1030). It never checks `part.thought`, so thought/reasoning parts are mixed into `AssistantMessage.content`.

**Contrast with live streaming:** The live streaming path (`_translate_text_content()` at line 397) correctly separates thought parts from text parts at lines 422-443:

```python
for part in adk_event.content.parts:
    if has_thought_support:
        thought_value = getattr(part, 'thought', None)
        is_thought = thought_value is True
    if is_thought:
        thought_parts.append(part.text)
    else:
        text_parts.append(part.text)
```

This asymmetry means that during a live session, users see thoughts rendered as THINKING events (separate from chat). But when the session is reloaded via `adk_events_to_messages()`, the same thoughts appear as regular chat text — a clear behavioral inconsistency.

**Impact:** Internal model reasoning (which can be verbose and confusing) appears as visible chat content to end users on session reload. This is both a UX defect and potentially a data exposure concern.

---

## PR #1110 Evaluation: Separate thought parts from text in message history

### Overall Assessment: GOOD — Viable fix with minor observations

---

### 1. Correctness

The fix is **correct** in its core approach:

- **New `_is_thought_part()` helper** (lines 997-1005 in the PR diff): Properly reuses the existing `_check_thought_support()` function for backwards compatibility with older google-genai SDK versions. Uses `getattr(part, 'thought', None)` with an `is True` check, which is safe against MagicMock objects (verified: MagicMock attributes return mock objects, and `mock is True` evaluates to `False`).

- **Part separation loop** (lines 1038-1047): Correctly classifies each part as either `thinking_content` or `text_content`, mirroring the same logic used in the live streaming handler `_translate_text_content()`.

- **ReasoningMessage emission** (lines 1088-1094): Emits a `ReasoningMessage(role="reasoning")` before the `AssistantMessage`, which matches how the live streaming path emits THINKING events before TEXT_MESSAGE events.

- **User message handling** (lines 1073-1075): Correctly strips thought parts from user events and skips events that contain only thoughts for the user role.

- **Conditional AssistantMessage** (lines 1098-1105): Only creates an `AssistantMessage` if there is visible `text_content` or `tool_calls`. This prevents empty assistant messages when an event contains only thoughts.

### 2. Consistency with Live Streaming Path

| Aspect | Live Stream (`_translate_text_content`) | History (`adk_events_to_messages` after fix) |
|--------|----------------------------------------|----------------------------------------------|
| Thought detection | `_check_thought_support()` + `getattr(part, 'thought', None) is True` | `_is_thought_part()` → same logic |
| Thought output | THINKING_START/THINKING_TEXT_MESSAGE_*/THINKING_END events | ReasoningMessage with role="reasoning" |
| Ordering | Thoughts emitted before text | ReasoningMessage appended before AssistantMessage |
| User messages | N/A (user events don't go through text translation) | Thought parts excluded; thought-only events skipped |

The approaches are consistent in intent. The live streaming path emits THINKING events (streaming protocol), while history reconstruction emits `ReasoningMessage` objects (materialized messages). This is the correct distinction — streaming events vs. snapshot messages are different representations of the same data.

### 3. Test Coverage

The PR adds **10 new tests** in a `TestThoughtPartSeparation` class:

| Test | Scenario | Verdict |
|------|----------|---------|
| `test_thought_parts_emitted_as_reasoning_message` | Mixed thought + text → ReasoningMessage + AssistantMessage | Good |
| `test_multiple_thought_parts_concatenated` | Multiple thought parts → single ReasoningMessage | Good |
| `test_thought_only_event_emits_reasoning_only` | Only thoughts → only ReasoningMessage (no empty AssistantMessage) | Good |
| `test_user_message_thought_parts_excluded` | User event with thoughts → thoughts stripped | Good |
| `test_user_message_with_only_thought_parts_skipped` | User event with only thoughts → skipped entirely | Good |
| `test_thought_parts_with_tool_calls` | Thoughts + text + tool calls → ReasoningMessage + AssistantMessage with tools | Good |
| `test_thought_only_with_tool_calls` | Only thoughts + tool calls → ReasoningMessage + AssistantMessage(content=None, tool_calls) | Good |
| `test_no_thought_support_treats_all_as_text` | Old SDK without thought support → all parts treated as text (backwards compat) | Good |
| `test_conversation_with_reasoning_preserves_order` | Multi-turn conversation → correct ordering across turns | Good |
| `test_reasoning_message_serializes_correctly` | Serialization → correct JSON with `role="reasoning"` | Good |

**Coverage assessment:** The tests are thorough and cover the important scenarios including edge cases (thought-only events, user messages with thoughts, no thought support, serialization). All tests use `@patch('ag_ui_adk.event_translator._check_thought_support')` appropriately.

**One gap worth noting:** There is no test for an event where `part.text` is empty/None alongside a thought part (e.g., `parts=[{"text": "", "thought": True}, {"text": "Hello"}]`). The existing code handles this via `if not hasattr(part, 'text') or not part.text: continue`, but an explicit test would strengthen confidence. This is a minor observation, not a blocker.

### 4. Dependency Bump

The PR bumps `ag-ui-protocol>=0.1.10` to `>=0.1.11` in `pyproject.toml`. This is necessary because `ReasoningMessage` was introduced as part of the reasoning spec (PR #1050). The version constraint is correct — `ReasoningMessage` is available in `ag-ui-protocol` and is already defined in `sdks/python/ag_ui/core/types.py:138`.

### 5. Documentation

The PR updates the docstring of `adk_events_to_messages()` to document the new behavior:

> Thought parts (Part.thought=True) are separated from regular text and emitted as ReasoningMessage objects so the client can render them distinctly instead of leaking internal model reasoning into the visible chat history.

This is adequate for inline documentation. No external documentation changes are included, but the existing protocol docs already document `ReasoningMessage` in `docs/sdk/python/core/types.mdx:223-241`.

### 6. Potential Concerns

1. **ReasoningMessage ID convention**: The PR uses `f"{event_id}-reasoning"` as the ID for reasoning messages. This is a reasonable convention but is not documented anywhere as a standard. It creates a stable, deterministic ID tied to the source event, which is good for idempotency.

2. **No `encrypted_value` support**: The `ReasoningMessage` type supports an optional `encrypted_value` field, but the PR doesn't populate it. This is acceptable — ADK thought parts from Gemini don't include encrypted values. If encrypted reasoning is needed in the future, it can be added.

3. **Missing newline at end of file**: The diff shows `\ No newline at end of file` for `event_translator.py`. This is cosmetic but should ideally be fixed.

4. **`_is_thought_part` is a module-level function**: It's defined outside the `EventTranslator` class, which is consistent with `adk_events_to_messages` itself being a standalone function. This is appropriate.

---

## Summary

| Dimension | Rating | Notes |
|-----------|--------|-------|
| Issue validity | Valid | Clear behavioral inconsistency between live streaming and session reload |
| Fix correctness | Good | Mirrors live streaming logic; handles edge cases properly |
| Backwards compatibility | Good | Falls back gracefully when SDK lacks thought support |
| Test coverage | Good | 10 tests covering primary scenarios and edge cases |
| Documentation | Adequate | Docstring updated; external docs already cover ReasoningMessage |
| Code quality | Good | Clean, minimal diff; reuses existing infrastructure |

**Recommendation:** The issue is valid and the PR is a viable fix. It can be merged with confidence. The minor observations above (missing EOF newline, no test for empty thought text) are not blockers.
