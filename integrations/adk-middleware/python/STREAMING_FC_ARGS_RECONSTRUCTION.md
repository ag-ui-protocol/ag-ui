# Streaming Function Call Arguments — Reconstruction Guide

## Overview

This feature enabled **Mode A streaming** of function call arguments from Gemini 3+ models via Vertex AI's `stream_function_call_arguments=True`. It was removed because the upstream ADK bugs (google/adk-python#4311) made it unreliable without monkey-patches that became difficult to maintain.

When the upstream fix is released, this document provides everything needed to reconstruct the feature.

## Prerequisites

- Gemini 3+ model (e.g., `gemini-3-flash-preview`)
- Vertex AI credentials:
  - `GOOGLE_GENAI_USE_VERTEXAI=TRUE`
  - `GOOGLE_CLOUD_PROJECT=<your-project>`
  - `GOOGLE_CLOUD_LOCATION=global`
- `google-adk` with fixed `StreamingResponseAggregator` (see google/adk-python#4311)
- For testing: `VERTEX_AI_API_ENDPOINT=https://generativelanguage.googleapis.com` (Vertex AI Public API)

## Upstream Issue

https://github.com/google/adk-python/issues/4311

Two bugs required workarounds:

### 1. Aggregator First-Chunk Bug

`StreamingResponseAggregator._process_function_call_part` misrouted the first streaming chunk into the non-streaming branch.

**Symptom**: When Gemini 3 models stream function call arguments, the first chunk carries:
- `function_call.name` (the tool name)
- `function_call.will_continue = True` (more chunks to come)
- `function_call.partial_args = None` (no args on first chunk)

The original code only checked `hasattr(partial_args)` to decide streaming vs. non-streaming. The first chunk fails this check, causing it to be treated as a complete function call with empty args.

**Solution**: Also check `will_continue=True` to recognize streaming starts.

### 2. Thought-Signature Loss

Gemini 3 models dropped `thought_signature` from function_call parts in session history, causing validation failures on subsequent turns.

**Symptom**: On the second turn in a multi-turn conversation, the LLM request contains function_call parts without `thought_signature`. The ADK validator then raises an error because these parts are considered incomplete.

**Solution**: Harvest existing signatures from session history and inject them (or a skip sentinel) before the LLM sees the request.

## Workaround Code (from deleted `src/ag_ui_adk/workarounds.py`)

### Workaround 1: Aggregator Monkey-Patch

```python
_patch_applied = False

def apply_aggregator_patch() -> None:
    """Monkey-patch StreamingResponseAggregator to handle streaming FC first chunk.

    This patch is idempotent — calling it multiple times has no effect after
    the first successful application.
    """
    global _patch_applied
    if _patch_applied:
        return

    try:
        from google.adk.utils.streaming_utils import StreamingResponseAggregator
    except ImportError:
        logger.warning("Could not import StreamingResponseAggregator; skipping patch")
        return

    from google.genai import types  # noqa: F811

    _original = StreamingResponseAggregator._process_function_call_part

    def _patched_process_function_call_part(self: Any, part: types.Part) -> None:
        fc = part.function_call

        has_partial_args = hasattr(fc, "partial_args") and fc.partial_args
        will_continue = getattr(fc, "will_continue", None)

        # Streaming first chunk: has name + will_continue but no partial_args yet.
        # Route it to the streaming path so _current_fc_name is set properly.
        if not has_partial_args and will_continue and fc.name:
            if getattr(part, "thought_signature", None) and not self._current_thought_signature:
                self._current_thought_signature = part.thought_signature
            if getattr(fc, "partial_args", None) is None:
                fc.partial_args = []
            self._process_streaming_function_call(fc)
            return

        # End-of-stream marker: no partial_args, no name, will_continue is None/False.
        # If we have accumulated streaming state, flush it.
        if (
            not has_partial_args
            and not fc.name
            and not will_continue
            and self._current_fc_name
        ):
            self._flush_text_buffer_to_sequence()
            self._flush_function_call_to_sequence()
            return

        # Default: delegate to original implementation
        _original(self, part)

    StreamingResponseAggregator._process_function_call_part = _patched_process_function_call_part
    _patch_applied = True
    logger.info("Applied StreamingResponseAggregator monkey-patch for streaming FC first-chunk bug")
```

### Workaround 2: Thought-Signature Repair Callback

```python
SKIP_SENTINEL = b"skip_thought_signature_validator"

def repair_thought_signatures(
    callback_context: Any,
    llm_request: Any,
) -> None:
    """Ensure every function_call Part has a thought_signature before the LLM call.

    Strategy:
    1. Harvest real signatures already present in contents or session events.
    2. Inject cached real signature or skip sentinel for any missing ones.

    This function is intended to be used as a ``before_model_callback`` on an
    ``LlmAgent``.
    """
    session_id = getattr(callback_context.session, "id", "unknown")

    sig_cache: Dict[str, bytes] = {}

    def _harvest(parts: list) -> None:
        for part in parts:
            fc = getattr(part, "function_call", None)
            if not fc:
                continue
            sig = getattr(part, "thought_signature", None)
            if sig and sig != SKIP_SENTINEL:
                fc_id = getattr(fc, "id", None)
                fc_name = getattr(fc, "name", None)
                key = f"{session_id}:{fc_id or fc_name}"
                sig_cache[key] = sig

    for content in llm_request.contents:
        _harvest(getattr(content, "parts", None) or [])

    if hasattr(callback_context.session, "events"):
        for event in callback_context.session.events:
            if hasattr(event, "content") and event.content:
                _harvest(getattr(event.content, "parts", None) or [])

    repaired = 0
    for content in llm_request.contents:
        for part in getattr(content, "parts", None) or []:
            fc = getattr(part, "function_call", None)
            if not fc:
                continue
            if getattr(part, "thought_signature", None):
                continue

            fc_id = getattr(fc, "id", None)
            fc_name = getattr(fc, "name", None)
            key = f"{session_id}:{fc_id or fc_name}"
            cached = sig_cache.get(key)
            part.thought_signature = cached if cached else SKIP_SENTINEL
            repaired += 1

    if repaired:
        logger.info("Repaired %d function_call part(s) with missing thought_signature", repaired)

    return None  # continue to LLM
```

## Insertion Points

### 1. `ADKAgent.__init__` (src/ag_ui_adk/adk_agent.py)

Add parameter:
```python
streaming_function_call_arguments: bool = False,
```

Store and apply patch:
```python
self._streaming_function_call_arguments = streaming_function_call_arguments
if streaming_function_call_arguments:
    apply_aggregator_patch()
```

Update the docstring to document the parameter:
```python
            streaming_function_call_arguments: Whether to enable Mode A streaming of function call
                arguments from Gemini 3+ models via Vertex AI. Requires streaming_function_call_arguments=True
                in the model's GenerateContentConfig. When enabled, function call arguments are streamed
                in real-time as partial events, allowing UI frameworks to show progressive updates.
                Defaults to False. Requires upstream ADK fix for google/adk-python#4311 to be reliable.
```

### 2. `ADKAgent.from_app()` classmethod (src/ag_ui_adk/adk_agent.py)

Add same parameter:
```python
streaming_function_call_arguments: bool = False,
```

Pass to constructor in the return statement:
```python
return cls(
    adk_agent=app.root_agent,
    app_name=app.name,
    ...
    streaming_function_call_arguments=streaming_function_call_arguments,
    ...
)
```

Update docstring:
```python
        streaming_function_call_arguments: Whether to enable Mode A streaming of function call arguments
            from Gemini 3+ models. Requires GOOGLE_GENAI_USE_VERTEXAI=TRUE and appropriate credentials.
```

### 3. Thought-Signature Callback Injection (src/ag_ui_adk/adk_agent.py, in `_start_new_execution`)

After `adk_agent = self._adk_agent.model_copy(deep=True)`:

```python
if self._streaming_function_call_arguments and isinstance(adk_agent, LlmAgent):
    existing = adk_agent.before_model_callback
    if existing is None:
        adk_agent.before_model_callback = repair_thought_signatures
    elif isinstance(existing, list):
        if repair_thought_signatures not in existing:
            existing.append(repair_thought_signatures)
    elif existing is not repair_thought_signatures:
        adk_agent.before_model_callback = [existing, repair_thought_signatures]
```

### 4. EventTranslator Construction (src/ag_ui_adk/adk_agent.py, in `_start_new_execution`)

After creating the translator, pass the flag:

```python
translator = EventTranslator(
    ...
    streaming_function_call_arguments=self._streaming_function_call_arguments,
)
```

### 5. Partial Event Persistence (src/ag_ui_adk/adk_agent.py, after early return on LRO)

When the agent returns early due to an LRO tool call, manually persist the partial FunctionCall event to the session:

```python
if getattr(adk_event, 'partial', False) and adk_event.content:
    from google.adk.sessions.session import Event as ADKSessionEvent
    import time as _time_mod
    fc_event = ADKSessionEvent(
        timestamp=_time_mod.time(),
        author=getattr(adk_event, 'author', 'assistant'),
        content=adk_event.content,
        invocation_id=getattr(adk_event, 'invocation_id', None) or input.run_id,
    )
    await self._session_manager._session_service.append_event(session, fc_event)
```

### 6. EventTranslator State Initialization (src/ag_ui_adk/event_translator.py)

Add `streaming_function_call_arguments` constructor param:

```python
def __init__(
    self,
    ...
    streaming_function_call_arguments: bool = False,
):
    ...
    self._streaming_fc_args_enabled = streaming_function_call_arguments
```

Add Mode A state variables after Mode B state variables:

```python
# Mode A streaming FC detection (for Gemini 3 streaming_function_call_arguments)
self._backend_streaming_fc_ids: set[str] = set()
self._active_streaming_fc_id: Optional[str] = None
self._confirmed_to_streaming_id: Dict[str, str] = {}
```

Note: `_streaming_function_calls`, `_completed_streaming_function_calls`, `_pending_streaming_completion_id`, `_last_completed_streaming_fc_name`, `_last_completed_streaming_fc_id` are shared with Mode B and may still exist in the codebase.

### 7. Mode A Detection Logic (src/ag_ui_adk/event_translator.py, in `translate()` method)

In the function call processing section, add Mode A detection before Mode B:

```python
# Mode A: stream_function_call_arguments (Gemini 3+)
# Only active when explicitly enabled via streaming_function_call_arguments=True
is_mode_a = self._streaming_fc_args_enabled and (
    (has_partial_args and func_call.name and will_continue
     and not self._active_streaming_fc_id)                 # first chunk: name + partial_args + will_continue
    or (not func_call.name and not has_args
        and not self._active_streaming_fc_id)                 # nameless first chunk (ADK doesn't propagate name to partials)
    or (not func_call.name and self._active_streaming_fc_id)  # end/continuation chunk (no name, active streaming)
)

# Mode B: accumulated args delta (progressive SSE / ADK aggregator)
# Only active when Mode A is not handling this chunk
is_mode_b = (
    not is_mode_a
    and has_args
    and (func_call.name or (getattr(func_call, 'id', None) or '') in self._streaming_function_calls)
)

is_streaming_fc = is_mode_a or is_mode_b

if is_streaming_fc:
    async for event in self._translate_streaming_function_call(func_call):
        yield event
    continue
```

Handle client_tool_names filtering carefully (don't filter when Mode A is active):

```python
filter_by_client_name = not self._streaming_fc_args_enabled
```

### 8. Add Helper Methods to EventTranslator (src/ag_ui_adk/event_translator.py)

```python
def _json_paths_match_any_client_tool(self, json_paths: set[str]) -> bool:
    """Check if any json_path in the set matches a client tool schema.

    This is used to distinguish between client tools (which match) and
    backend tools (which don't match any known schema).

    Args:
        json_paths: Set of JSON paths from partial_args

    Returns:
        True if any json_path matches a client tool's input schema
    """
    if not json_paths or not self._client_tool_schemas:
        return False

    for schema in self._client_tool_schemas.values():
        properties = schema.get("properties", {})
        for json_path in json_paths:
            # json_path looks like "$.field_name" or "$.nested.field"
            # Extract the root field name
            if json_path.startswith("$."):
                field_path = json_path[2:]
                root_field = field_path.split(".")[0]
                if root_field in properties:
                    return True
    return False

def _infer_tool_name_from_json_paths(self, json_paths: set[str]) -> Optional[str]:
    """Infer tool name from json_paths in partial_args.

    When the first chunk doesn't carry a name (ADK limitation with streaming
    aggregator), we can infer it from the partial_args json_paths by matching
    against known client tool schemas.

    Args:
        json_paths: Set of JSON paths from partial_args (e.g., {"$.document"})

    Returns:
        Tool name if a match is found, otherwise None
    """
    if not json_paths or not self._client_tool_schemas:
        return None

    for tool_name, schema in self._client_tool_schemas.items():
        properties = schema.get("properties", {})
        for json_path in json_paths:
            if json_path.startswith("$."):
                field_path = json_path[2:]
                root_field = field_path.split(".")[0]
                if root_field in properties:
                    return tool_name
    return None
```

### 9. Mode A Streaming Logic (src/ag_ui_adk/event_translator.py, in `_translate_streaming_function_call`)

Extend the method to handle Mode A scenarios. Key behavior:

- **First chunk** (name + will_continue): Initialize streaming state, emit TOOL_CALL_START
- **Continuation chunks** (nameless): Lookup active streaming FC by ID, emit TOOL_CALL_ARGS for args delta
- **End chunk** (no name, no will_continue): Emit TOOL_CALL_END, clean up state
- **Late backend detection**: If continuation chunk reveals non-matching json_paths, mark FC as backend tool and suppress from AG-UI

```python
async def _translate_streaming_function_call(self, func_call) -> AsyncGenerator[BaseEvent, None]:
    """Translate a streaming function call (Mode A or Mode B) to AG-UI events.

    Mode A (Gemini 3 streaming_function_call_arguments):
    - First chunk: name + will_continue + [no partial_args]
    - Continuation: [no name] + partial_args
    - End: [no name] + no partial_args + will_continue=False/None

    Mode B (Progressive SSE / ADK aggregator):
    - Chunk: [name] + accumulated args (from aggregator)
    - End: [name] + accumulated args + will_continue=False
    """
    tool_call_id = getattr(func_call, 'id', None)
    tool_name = getattr(func_call, 'name', None)
    args = getattr(func_call, 'args', None)
    will_continue = getattr(func_call, 'will_continue', None)
    partial_args = getattr(func_call, 'partial_args', None)

    has_partial_args = bool(partial_args)
    has_args = bool(args)

    # Mode A: Handle continuation/end chunks (no name)
    if self._streaming_fc_args_enabled and not tool_name:
        if self._active_streaming_fc_id:
            tool_call_id = self._active_streaming_fc_id

        # Check if this is a backend tool (json_paths don't match client schemas)
        json_paths = set()
        if partial_args:
            json_paths = {getattr(p, 'json_path', '') for p in partial_args if getattr(p, 'json_path', '')}

        if tool_call_id in self._backend_streaming_fc_ids:
            # Already marked as backend - skip
            return

        if json_paths and not self._json_paths_match_any_client_tool(json_paths):
            # Nameless chunk with non-matching json_paths -> backend tool
            self._backend_streaming_fc_ids.add(tool_call_id)
            return

        # Emit args delta
        if partial_args:
            async for event in self._emit_tool_call_args(tool_call_id, partial_args):
                yield event

        # Check for end marker (no name, no will_continue, no partial_args)
        if not has_partial_args and not will_continue and tool_call_id in self._streaming_function_calls:
            async for event in self._emit_tool_call_end(tool_call_id):
                yield event
            self._active_streaming_fc_id = None
        return

    # Mode A: Handle first chunk (name + will_continue)
    if self._streaming_fc_args_enabled and tool_name and will_continue and not has_args:
        # Try to infer or use explicit name
        if not tool_name and partial_args:
            json_paths = {getattr(p, 'json_path', '') for p in partial_args if getattr(p, 'json_path', '')}
            tool_name = self._infer_tool_name_from_json_paths(json_paths) or ""

        # Emit start
        async for event in self._emit_streaming_fc_start(tool_call_id, tool_name):
            yield event
        self._active_streaming_fc_id = tool_call_id
        return

    # Mode B or Mode A non-streaming path would be below...
    # (Rest of the existing logic)
```

## Example Usage (from test_streaming_fc_args_integration.py)

```python
from google.genai import types
from google.adk.agents import Agent
from ag_ui_adk import ADKAgent

# Configure model to stream function call arguments
generate_config = types.GenerateContentConfig(
    tool_config=types.ToolConfig(
        function_calling_config=types.FunctionCallingConfig(
            stream_function_call_arguments=True
        )
    )
)

agent = Agent(
    name="writer",
    model="gemini-3-flash-preview",
    tools=[write_document, AGUIToolset()],
    generate_content_config=generate_config,
)

# Create ADKAgent with streaming enabled
adk_agent = ADKAgent(
    adk_agent=agent,
    streaming_function_call_arguments=True,
)

# Use with AG-UI protocol
async for event in adk_agent.run(input_data):
    print(event.type)
```

## Test Patterns

Key test scenarios that were covered (see `tests/test_lro_filtering.py` and `tests/test_streaming_fc_args_integration.py`):

### Unit Tests (test_lro_filtering.py)

1. **Mode A first-chunk dispatch** (`test_mode_a_streaming_fc_with_flag_enabled`):
   - Partial event with name + will_continue=True + args=None enters streaming path when flag enabled
   - Emits TOOL_CALL_START, TOOL_CALL_ARGS (on continuation), TOOL_CALL_END

2. **Mode A skipped without flag** (`test_mode_a_first_chunk_skipped_without_flag`):
   - Same event is ignored when streaming_function_call_arguments=False (default)

3. **Nameless chunk correlation** (`test_streaming_fc_args_nameless_chunks_stream_immediately`):
   - Continuation chunks (name=None) map back to active streaming FC id
   - Args deltas computed correctly

4. **Backend tool filtering** (`test_streaming_fc_args_multi_tool_disambiguation`):
   - Named backend tools skipped on first chunk via client_tool_names filter bypass
   - Nameless backend tools detected via json_path mismatch

5. **Late backend detection**:
   - Nameless first chunk starts streaming, second chunk reveals non-matching json_paths
   - Reclassified as backend, suppressed from AG-UI events

6. **Multi-tool disambiguation**:
   - json_path matching against client_tool_schemas infers correct tool name
   - Works when first chunk carries no name

7. **Partial event persistence** (`test_partial_event_persistence`):
   - On early LRO return with aggregator patch, FunctionCall event manually persisted to session
   - Allows resumption to see the in-flight tool call

8. **Thought-signature repair**:
   - before_model_callback injects skip sentinel for missing signatures
   - Prevents validation errors on multi-turn conversations

### Integration Tests (test_streaming_fc_args_integration.py)

- End-to-end streaming with real Gemini 3 model and Vertex AI
- Requires GOOGLE_GENAI_USE_VERTEXAI=TRUE and valid credentials
- Verifies streaming events match AG-UI protocol expectations
- Tests multi-turn conversations with signature repair

## Migration Strategy

### Phase 1: Restore the code

1. Re-add `workarounds.py` with both patching functions
2. Add `streaming_function_call_arguments` parameter to `ADKAgent.__init__` and `from_app()`
3. Extend `EventTranslator` with Mode A detection and helper methods
4. Add integration point in `_start_new_execution` for callback injection

### Phase 2: Test thoroughly

1. Run unit tests for Mode A dispatch logic
2. Run integration tests with Gemini 3 model (requires credentials)
3. Verify no regressions in existing Mode B (progressive SSE) behavior
4. Test multi-turn conversations for thought-signature repair

### Phase 3: Monitor and refine

1. Watch upstream ADK issue for fix announcements
2. Once google/adk-python#4311 is fixed, consider:
   - Removing workarounds entirely
   - Enabling Mode A by default (if stable)
   - Merging Mode A and Mode B into unified streaming logic

## Known Limitations (while workarounds exist)

1. **Monkey-patching side effects**: The patch modifies ADK internals globally, affecting all agent instances in the process
2. **Multi-instance compatibility**: If multiple ADKAgent instances need different streaming settings, only the first-enabled flag matters (patch is idempotent, can't be disabled)
3. **Thought-signature harvest**: Depends on session history being available; rare cases may fail if events are pruned
4. **Tool name inference**: Ambiguous if multiple client tools share the same json_path prefix

These limitations disappear once the upstream fix is available.

## References

- **Upstream Issue**: https://github.com/google/adk-python/issues/4311
- **Feature Branch**: `contextablemark/feat/toolcallingimprovements`
- **Removed Commits**:
  - `9d25d86a` feat(adk-middleware): stream FC args for opted-in LRO/HITL tools
  - `b624bb1f` feat(adk-middleware): add streaming_function_call_arguments to from_app()
  - `234055ef` feat(adk-middleware): auto-apply aggregator patch when streaming FC args enabled
  - `82279633` feat(adk-middleware): robust streaming function call arguments support
- **Related Files**:
  - `src/ag_ui_adk/adk_agent.py` - Main agent orchestrator
  - `src/ag_ui_adk/event_translator.py` - Event translation logic
  - `src/ag_ui_adk/workarounds.py` - Gemini 3 workarounds
  - `tests/test_lro_filtering.py` - Unit tests for streaming FC
  - `tests/test_streaming_fc_args_integration.py` - Integration tests
  - `tests/test_gemini3_workarounds.py` - Workaround-specific tests
