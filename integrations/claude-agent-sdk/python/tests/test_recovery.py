"""Restart controls use saved SDK identities, never inferred history callbacks."""
from copy import deepcopy
from types import SimpleNamespace
import pytest
from ag_ui.core import ToolMessage
from ag_ui_claude_sdk.recovery import RecoveryRun, SessionBinding, historical_tool_results
from claude_agent_sdk import get_session_messages_from_store

PENDING = {'id': 'call-original', 'name': 'Bash', 'input': {'command': 'echo test'}}

def request(behavior=None, call_id='call-original'):
    return SimpleNamespace(resume=[] if behavior is None else [SimpleNamespace(
        interrupt_id=call_id, status='resolved', payload={'behavior': behavior})])

def event(reason=None, pending=None, error=False):
    return SimpleNamespace(stop_reason=reason, deferred_tool_use=pending, is_error=error)

def hook_input(**updates):
    return {'hook_event_name': 'PreToolUse', 'tool_use_id': PENDING['id'],
            'tool_name': PENDING['name'], 'tool_input': PENDING['input'], **updates}

@pytest.mark.asyncio
@pytest.mark.parametrize('behavior', ['allow', 'deny'])
async def test_restart_replays_original_call_and_clears_only_after_completion(behavior):
    first = RecoveryRun(None, request())
    first.observe('native-uuid', 'original-environment', event('tool_deferred', deepcopy(PENDING)))
    saved = deepcopy(first.binding)
    second = RecoveryRun(saved, request(behavior))
    output = await second.hook(hook_input(), PENDING['id'], {})
    assert output['hookSpecificOutput']['permissionDecision'] == behavior
    assert saved.pending['id'] == PENDING['id']
    second.observe('native-uuid', 'original-environment', event())
    assert saved.pending is None
    assert saved.session_id == 'native-uuid'
    assert await second.hook(hook_input(), PENDING['id'], {}) == {}
    with pytest.raises(ValueError, match='No saved SDK deferral'):
        RecoveryRun(deepcopy(saved), request(behavior))

@pytest.mark.asyncio
async def test_unanswered_deferral_remains_actionable_after_restart():
    run = RecoveryRun(SessionBinding('native', 'profile', deepcopy(PENDING)), request())
    assert run.awaiting_decision
    assert run.interrupts[0]['id'] == PENDING['id']
    assert (await run.hook(hook_input(), PENDING['id'], {}))['hookSpecificOutput']['permissionDecision'] == 'defer'

@pytest.mark.asyncio
async def test_mismatch_and_missing_tool_do_not_consume_approval():
    run = RecoveryRun(SessionBinding('native', 'profile', deepcopy(PENDING)), request('allow'))
    output = await run.hook(hook_input(tool_input={'command': 'different'}), PENDING['id'], {})
    assert output['hookSpecificOutput']['permissionDecision'] == 'deny'
    with pytest.raises(ValueError, match='does not match'):
        run.observe('native', 'profile', event())
    run = RecoveryRun(SessionBinding('native', 'profile', deepcopy(PENDING)), request('allow'))
    with pytest.raises(ValueError, match='unavailable'):
        run.observe('native', 'profile', event('tool_deferred_unavailable', PENDING, True))
    assert run.binding.pending == PENDING
    with pytest.raises(ValueError, match='UUID'):
        run.observe('replacement', 'profile')


def test_callback_history_and_parallel_approvals_are_not_recoverable():
    with pytest.raises(ValueError, match='No saved SDK deferral'):
        RecoveryRun(SessionBinding('native', 'profile'), request('allow'))
    multiple = request('allow')
    multiple.resume *= 2
    with pytest.raises(ValueError, match='one tool call'):
        RecoveryRun(SessionBinding('native', 'profile', PENDING), multiple)

@pytest.mark.asyncio
@pytest.mark.parametrize('behavior', ['allow', 'deny'])
async def test_adapter_restart_restores_profile_original_uuid_and_decision(monkeypatch, behavior):
    from ag_ui.core import RunAgentInput
    from claude_agent_sdk import ResultMessage, SystemMessage
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    import ag_ui_claude_sdk.adapter as module
    import claude_agent_sdk
    class Store:
        value = None
        async def load(self, thread):
            return deepcopy(self.value)
        async def save(self, thread, binding):
            self.value = deepcopy(binding)
    store = Store()
    options_seen = []
    decisions = []
    class Worker:
        def __init__(self, thread, options):
            self.options = options
            options_seen.append(options)
        async def start(self): pass
        async def stop(self): pass
        def is_alive(self): return True
        async def query(self, prompt, session_id):
            yield SystemMessage(subtype='init', data={'session_id': 'native-uuid'})
            if self.options.resume:
                assert prompt is None
                response = await self.options.hooks['PreToolUse'][-1].hooks[0](hook_input(), PENDING['id'], {})
                decisions.append(response['hookSpecificOutput']['permissionDecision'])
            yield ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1,
                                is_error=False, num_turns=1, session_id='native-uuid',
                                stop_reason=None if self.options.resume else 'tool_deferred',
                                deferred_tool_use=None if self.options.resume else deepcopy(PENDING))
    monkeypatch.setattr(module, 'SessionWorker', Worker)
    monkeypatch.setattr(claude_agent_sdk, 'get_session_info', lambda *a, **k: SimpleNamespace(session_id='native-uuid'))
    profiles = []
    async def resolve(profile):
        profiles.append(profile)
        return {'cwd': '/original-project', 'permission_mode': 'default'}
    def adapter():
        return ClaudeAgentAdapter('test', session_binding_store=store, resolve_profile=resolve, execution_profile='original-profile')
    def run_input(resume=None):
        return RunAgentInput(thread_id='public-thread', run_id='run', messages=[], tools=[], context=[], state={}, forwarded_props={}, resume=resume)
    first = adapter()
    events = [e async for e in first.run(run_input())]
    assert events[-1].outcome.type == 'interrupt'
    assert events[-1].outcome.interrupts[0].id == PENDING['id']
    await first.shutdown()
    second = adapter()
    events = [e async for e in second.run(run_input([{'interruptId': PENDING['id'], 'status': 'resolved', 'payload': {'behavior': behavior}}]))]
    assert events[-1].type == 'RUN_FINISHED'
    assert options_seen[1].resume == 'native-uuid'
    assert options_seen[1].fork_session is False
    assert options_seen[1].cwd == '/original-project'
    assert decisions == [behavior]
    assert store.value.pending is None
    assert profiles == ['original-profile', 'original-profile']
    await second.shutdown()

@pytest.mark.asyncio
async def test_completed_tool_stays_completed_when_model_later_fails():
    run = RecoveryRun(SessionBinding('native', 'profile', deepcopy(PENDING)), request('allow'))
    await run.hook(hook_input(), PENDING['id'], {})
    assert run.observe_tool_result(PENDING['id'])
    run.observe('native', 'profile', event(error=True))
    assert run.binding.pending is None

@pytest.mark.parametrize("as_options", [False, True])
@pytest.mark.parametrize("allowed", [[], ["Read"]])
def test_profile_preserves_run_context_and_generated_permissions(make_input, as_options, allowed):
    from claude_agent_sdk import ClaudeAgentOptions
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    profile = {"system_prompt": "Trusted profile instructions", "allowed_tools": allowed}
    if as_options:
        profile = ClaudeAgentOptions(**profile)
    inp = make_input(state={"count": 42}, context=[{"description": "Current context", "value": "context-value"}], tools=[{"name": "confirm", "description": "Confirm", "parameters": {"type": "object"}}])
    options = ClaudeAgentAdapter("test").build_options(inp, profile_options=profile)
    assert "Trusted profile instructions" in options.system_prompt
    assert "42" in options.system_prompt
    assert "context-value" in options.system_prompt
    assert set(options.allowed_tools) == {*allowed, "mcp__ag_ui__confirm", "mcp__ag_ui__ag_ui_update_state"}

@pytest.mark.asyncio
async def test_default_frontend_run_defers_and_retains_local_binding(monkeypatch, make_input):
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    from claude_agent_sdk import SystemMessage, ResultMessage
    import ag_ui_claude_sdk.adapter as module
    pending = {"id": "frontend-call", "name": "mcp__ag_ui__confirm", "input": {}}
    calls = []
    class Worker:
        def __init__(self, thread, options): self.options = options
        async def start(self): pass
        async def stop(self): pass
        def is_alive(self): return True
        async def query(self, prompt, session_id):
            calls.append(prompt)
            decision = await self.options.hooks["PreToolUse"][-1].hooks[0](
                {"hook_event_name": "PreToolUse", "tool_name": pending["name"], "tool_use_id": pending["id"], "tool_input": {}}, pending["id"], {})
            assert decision["hookSpecificOutput"]["permissionDecision"] == "defer"
            yield SystemMessage(subtype="init", data={"session_id": "native"})
            yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
                                num_turns=1, session_id="native", stop_reason="tool_deferred", deferred_tool_use=pending)
    monkeypatch.setattr(module, "SessionWorker", Worker)
    adapter = ClaudeAgentAdapter("test")
    inp = make_input(messages=[{"id":"user","role":"user","content":"Confirm"}], tools=[{"name":"confirm","description":"Confirm","parameters":{"type":"object"}}])
    events = [e async for e in adapter.run(inp)]
    assert events[-1].type == "RUN_FINISHED"
    assert events[-1].outcome.pending_tool_call_ids == [pending["id"]]
    assert len(calls) == 1
    assert adapter._memory_bindings[inp.thread_id].pending == pending
    await adapter.clear_session(inp.thread_id)
    assert not adapter._memory_bindings
    await adapter.shutdown()

@pytest.mark.asyncio
@pytest.mark.parametrize("eviction", ["ttl", "capacity"])
async def test_local_frontend_bindings_are_bounded(eviction):
    from datetime import datetime, timedelta
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    adapter = ClaudeAgentAdapter("test", max_workers=1, worker_ttl_seconds=60)
    await adapter._save_binding("old", SessionBinding("old-native", "default"))
    if eviction == "ttl":
        adapter._binding_last_used["old"] = datetime.now() - timedelta(seconds=61)
    else:
        await adapter._save_binding("new", SessionBinding("new-native", "default"))
    adapter._evict_memory_bindings()
    assert "old" not in adapter._memory_bindings
    assert len(adapter._memory_bindings) <= 1
    await adapter.shutdown()

@pytest.mark.asyncio
@pytest.mark.parametrize("new_input", [False, True])
async def test_new_user_input_survives_recovery_once_in_order(monkeypatch, make_input, new_input):
    from claude_agent_sdk import ResultMessage
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    import ag_ui_claude_sdk.adapter as module
    import claude_agent_sdk
    calls = []
    class Store:
        async def load(self, thread): return SessionBinding("native-uuid", "profile", deepcopy(PENDING))
        async def save(self, thread, binding): pass
    class Worker:
        def __init__(self, thread, options): self.options = options
        async def start(self): pass
        async def stop(self): pass
        def is_alive(self): return True
        async def query(self, prompt, session_id):
            calls.append(prompt)
            if len(calls) == 1:
                assert prompt is None
                await self.options.hooks["PreToolUse"][-1].hooks[0](hook_input(), PENDING["id"], {})
            yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="native-uuid")
    monkeypatch.setattr(module, "SessionWorker", Worker)
    monkeypatch.setattr(claude_agent_sdk, "get_session_info", lambda *a, **kw: SimpleNamespace(session_id="native-uuid"))
    async def profile_options(profile): return {}
    adapter = ClaudeAgentAdapter("test", session_binding_store=Store(), resolve_profile=profile_options, execution_profile="profile")
    messages = [{"id": "old", "role": "user", "content": "Old instruction"},
                {"id": "call", "role": "assistant", "toolCalls": [{"id": PENDING["id"], "type": "function", "function": {"name": "Bash", "arguments": "{}"}}]}]
    if new_input: messages.append({"id": "new", "role": "user", "content": "New instruction"})
    inp = make_input(messages=messages)
    from ag_ui.core import RunAgentInput
    inp = RunAgentInput.model_validate({**inp.model_dump(), "resume": [dict(interruptId=PENDING["id"], status="resolved", payload={"behavior": "allow"})]})
    events = [e async for e in adapter.run(inp)]
    assert events[-1].type == "RUN_FINISHED"
    assert calls == ([None, "New instruction"] if new_input else [None])
    await adapter.shutdown()

def test_recovery_preserves_users_before_and_after_tool_result(make_input):
    from ag_ui_claude_sdk.utils import recovery_user_messages
    inp = make_input(messages=[
        {"id": "old", "role": "user", "content": "Old"},
        {"id": "call", "role": "assistant", "toolCalls": [{"id": "native", "type": "function", "function": {"name": "render", "arguments": "{}"}}]},
        {"id": "new-1", "role": "user", "content": "First"},
        {"id": "result", "role": "tool", "toolCallId": "native", "content": "Rendered"},
        {"id": "new-2", "role": "user", "content": [{"type": "text", "text": "Second"}]},
    ])
    assert [message.id for message in recovery_user_messages(inp, "native")] == ["new-1", "new-2"]

@pytest.mark.asyncio
async def test_failed_queued_user_turn_stops_later_prompts():
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    from claude_agent_sdk import ResultMessage
    adapter = ClaudeAgentAdapter("test")
    recovery = RecoveryRun(None, request())
    calls = []
    def result(error=False):
        return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=error, num_turns=1, session_id="native")
    async def initial(): yield result()
    class Worker:
        async def query(self, prompt, session_id):
            calls.append(prompt)
            yield result(True)
    events = [e async for e in adapter._resume_with_user_input(Worker(), initial(), recovery, "thread", "profile", ["First", "Second"])]
    assert calls == ["First"]
    assert events[-1].is_error
    await adapter.shutdown()

@pytest.mark.asyncio
async def test_middleware_error_metadata_survives_restart(make_input):
    pending = {"id": "mcp-call", "name": "mcp__ag_ui__draw", "input": {}}
    inp = make_input(messages=[{"id": "result", "role": "tool", "toolCallId": pending["id"], "content": "original MCP error", "metadata": {"ag-ui:tool-result": {"error": ""}}}])
    run = RecoveryRun(SessionBinding("native", "profile", pending), inp)
    await run.hook({"hook_event_name": "PreToolUse", "tool_use_id": pending["id"], "tool_name": pending["name"], "tool_input": {}}, pending["id"], {})
    assert run.resolve_frontend_result("draw", {}) == {"content": "original MCP error", "error": ""}
    with pytest.raises(ValueError, match="no matching resumed result"):
        run.resolve_frontend_result("draw", {})

def mixed_request(behavior=None):
    result = SimpleNamespace(id='state-call-result', role='tool', tool_call_id='state-call',
                             content='State updated successfully', error=None)
    value = request(behavior)
    value.messages = [SimpleNamespace(role='assistant'), result]
    value.state = {'todos': [{'title': 'Persist across reload'}]}
    return value, result


@pytest.mark.asyncio
@pytest.mark.parametrize('behavior', ['allow', 'deny'])
async def test_native_decision_with_verified_historical_state_result(behavior):
    value, historical = mixed_request(behavior)
    before = deepcopy(value)
    run = RecoveryRun(SessionBinding('native', 'original', deepcopy(PENDING)), value,
                      historical_results=[historical])
    output = await run.hook(hook_input(), PENDING['id'], {})
    assert output['hookSpecificOutput']['permissionDecision'] == behavior
    assert run.observe_tool_result(PENDING['id'])
    assert not run.observe_tool_result(PENDING['id'])
    run.observe('native', 'original', event(error=True))
    assert run.binding.pending is None
    assert run.binding.session_id == 'native'
    assert value == before
    reloaded, _ = mixed_request()
    assert not RecoveryRun(deepcopy(run.binding), reloaded, historical_results=[historical]).awaiting_decision
    with pytest.raises(ValueError, match='No saved SDK deferral'):
        RecoveryRun(deepcopy(run.binding), value, historical_results=[historical])


def test_mixed_history_rejects_unverified_changed_duplicate_conflicting_and_wrong_id():
    binding = SessionBinding('native', 'original', deepcopy(PENDING))
    for change in ({}, {'content': 'changed'}, {'error': 'changed'}):
        value, historical = mixed_request('allow')
        trusted = deepcopy(historical)
        vars(historical).update(change)
        with pytest.raises(ValueError, match='No saved SDK deferral'):
            RecoveryRun(binding, value, historical_results=[trusted] if change else [])
    value, historical = mixed_request('allow')
    value.messages.append(deepcopy(historical))
    with pytest.raises(ValueError, match='Multiple results'):
        RecoveryRun(binding, value, historical_results=[historical])
    value, historical = mixed_request('allow')
    conflicting = deepcopy(historical)
    conflicting.tool_call_id = PENDING['id']
    value.messages.append(conflicting)
    with pytest.raises(ValueError, match='either a native decision'):
        RecoveryRun(binding, value, historical_results=[historical])
    value, historical = mixed_request('allow')
    value.resume[0].interrupt_id = 'wrong'
    with pytest.raises(ValueError, match='No saved SDK deferral matches this approval'):
        RecoveryRun(binding, value, historical_results=[historical])


@pytest.mark.asyncio
async def test_cold_restore_of_legacy_binding_verifies_transcript_and_fails_closed():
    binding = SessionBinding('native', 'original', deepcopy(PENDING))
    value, historical = mixed_request()
    reads = []
    async def load_history():
        reads.append(True)
        return [historical]
    assert (await RecoveryRun.restore(binding, value, (), load_history)).awaiting_decision
    value.resume = request('allow').resume
    assert (await RecoveryRun.restore(binding, value, (), load_history)).decision == {'behavior': 'allow'}
    assert len(reads) == 2
    value.resume[0].interrupt_id = 'wrong'
    with pytest.raises(ValueError, match='matches this approval'):
        await RecoveryRun.restore(binding, value, (), load_history)
    assert len(reads) == 2
    value.resume = request('allow').resume
    async def missing():
        return []
    with pytest.raises(ValueError, match='matches this frontend result'):
        await RecoveryRun.restore(binding, value, (), missing)
    async def unreadable():
        raise OSError('unreadable transcript')
    with pytest.raises(OSError, match='unreadable transcript'):
        await RecoveryRun.restore(binding, value, (), unreadable)


@pytest.mark.asyncio
async def test_real_sdk_session_store_reader_verifies_legacy_state_result():
    session_id = '11111111-1111-4111-8111-111111111111'
    class Store:
        async def append(self, key, entries):
            raise AssertionError('History verification must not write')
        async def load(self, key):
            assert key == {'project_key': '-original', 'session_id': session_id}
            return [
                {'type': 'user', 'uuid': 'user', 'parentUuid': None, 'sessionId': session_id,
                 'message': {'role': 'user', 'content': 'Update state then read'}},
                {'type': 'assistant', 'uuid': 'state', 'parentUuid': 'user', 'sessionId': session_id,
                 'message': {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'state-call', 'name': 'mcp__ag_ui__ag_ui_update_state', 'input': {}}]}},
                {'type': 'user', 'uuid': 'result', 'parentUuid': 'state', 'sessionId': session_id,
                 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'state-call', 'content': [{'type': 'text', 'text': 'State updated successfully'}]}]}},
            ]
    async def load_history():
        return historical_tool_results(await get_session_messages_from_store(Store(), session_id, '/original'))
    value, _ = mixed_request('allow')
    run = await RecoveryRun.restore(SessionBinding(session_id, 'original', deepcopy(PENDING)), value, (), load_history)
    assert run.decision == {'behavior': 'allow'}
    assert run.binding.session_id == session_id


@pytest.mark.asyncio
async def test_verified_native_historical_error_in_client_metadata():
    history = historical_tool_results([SimpleNamespace(message={'content': [{
        'type': 'tool_result', 'tool_use_id': 'state-call',
        'content': 'Permission denied', 'is_error': True,
    }]})])
    value, _ = mixed_request('allow')
    result = history[0].model_copy(update={'error': None, 'metadata': {
        'ag-ui:tool-result': {'error': 'Tool execution failed'},
    }})
    value.messages[1] = result
    binding = SessionBinding('native', 'original', deepcopy(PENDING))
    async def load_history():
        return history
    run = await RecoveryRun.restore(binding, value, (), load_history)
    output = await run.hook(hook_input(), PENDING['id'], {})
    assert output['hookSpecificOutput']['permissionDecision'] == 'allow'
    for update in (
        {'content': 'changed'},
        {'error': 'different explicit error'},
        {'metadata': {'ag-ui:tool-result': {'error': 'different metadata error'}}},
        {'metadata': {'ag-ui:tool-result': {'error': True}}},
        {'metadata': {'ag-ui:tool-result': None}},
    ):
        value.messages[1] = result.model_copy(update=update)
        with pytest.raises(ValueError, match='matches this frontend result'):
            await RecoveryRun.restore(binding, value, (), load_history)


@pytest.mark.asyncio
@pytest.mark.parametrize('completed', [False, True])
async def test_parallel_siblings_require_native_results(completed):
    meeting = {'id': 'meeting', 'name': 'mcp__ag_ui__scheduleTime', 'input': {'duration': 30}}
    binding = SessionBinding('native', 'original', deepcopy(meeting))
    value = request()
    value.messages = [
        ToolMessage(id='pie-result', role='tool', tool_call_id='pie', content=''),
        ToolMessage(id='bar-result', role='tool', tool_call_id='bar', content=''),
        ToolMessage(id='meeting-result', role='tool', tool_call_id='meeting', content='Meeting declined'),
    ]
    content = [
        {'type': 'tool_use', 'id': 'pie', 'name': 'mcp__ag_ui__pieChart', 'input': {}},
        {'type': 'tool_use', 'id': 'bar', 'name': 'mcp__ag_ui__barChart', 'input': {}},
        {'type': 'tool_use', **meeting},
    ]
    if completed:
        content.extend({'type': 'tool_result', 'tool_use_id': call_id,
                        'content': [{'type': 'text', 'text': ''}]} for call_id in ('pie', 'bar'))
    history = historical_tool_results([SimpleNamespace(message={'content': content})])
    async def load_history():
        return history
    if not completed:
        # Native tool_use records alone do not establish delivered sibling replies.
        with pytest.raises(ValueError, match='matches this frontend result'):
            await RecoveryRun.restore(binding, value, (), load_history)
        assert binding.pending == meeting
        return
    run = await RecoveryRun.restore(binding, value, (), load_history)
    await run.hook(hook_input(tool_use_id=meeting['id'], tool_name=meeting['name'], tool_input=meeting['input']), meeting['id'], {})
    assert run.resolve_frontend_result('scheduleTime', meeting['input']) == {'content': 'Meeting declined', 'error': None}
    with pytest.raises(ValueError, match='no matching resumed result'):
        run.resolve_frontend_result('scheduleTime', meeting['input'])
    assert run.observe_tool_result(meeting['id'])
    assert binding.pending is None
@pytest.mark.asyncio
@pytest.mark.parametrize("new_input", [False, True])
async def test_new_user_input_survives_recovery_once_in_order(monkeypatch, make_input, new_input):
    from claude_agent_sdk import ResultMessage
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    import ag_ui_claude_sdk.adapter as module
    import claude_agent_sdk
    calls = []
    class Store:
        async def load(self, thread): return SessionBinding("native-uuid", "profile", deepcopy(PENDING))
        async def save(self, thread, binding): pass
    class Worker:
        def __init__(self, thread, options): self.options = options
        async def start(self): pass
        async def stop(self): pass
        def is_alive(self): return True
        async def query(self, prompt, session_id):
            calls.append(prompt)
            if len(calls) == 1:
                assert prompt is None
                await self.options.hooks["PreToolUse"][-1].hooks[0](hook_input(), PENDING["id"], {})
            yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="native-uuid")
    monkeypatch.setattr(module, "SessionWorker", Worker)
    monkeypatch.setattr(claude_agent_sdk, "get_session_info", lambda *a, **kw: SimpleNamespace(session_id="native-uuid"))
    async def profile_options(profile): return {}
    adapter = ClaudeAgentAdapter("test", session_binding_store=Store(), resolve_profile=profile_options, execution_profile="profile")
    messages = [{"id": "old", "role": "user", "content": "Old instruction"},
                {"id": "call", "role": "assistant", "toolCalls": [{"id": PENDING["id"], "type": "function", "function": {"name": "Bash", "arguments": "{}"}}]}]
    if new_input: messages.append({"id": "new", "role": "user", "content": "New instruction"})
    inp = make_input(messages=messages)
    from ag_ui.core import RunAgentInput
    inp = RunAgentInput.model_validate({**inp.model_dump(), "resume": [dict(interruptId=PENDING["id"], status="resolved", payload={"behavior": "allow"})]})
    events = [e async for e in adapter.run(inp)]
    assert events[-1].type == "RUN_FINISHED"
    assert calls == ([None, "New instruction"] if new_input else [None])
    await adapter.shutdown()

def test_recovery_preserves_users_before_and_after_tool_result(make_input):
    from ag_ui_claude_sdk.utils import recovery_user_messages
    inp = make_input(messages=[
        {"id": "old", "role": "user", "content": "Old"},
        {"id": "call", "role": "assistant", "toolCalls": [{"id": "native", "type": "function", "function": {"name": "render", "arguments": "{}"}}]},
        {"id": "new-1", "role": "user", "content": "First"},
        {"id": "result", "role": "tool", "toolCallId": "native", "content": "Rendered"},
        {"id": "new-2", "role": "user", "content": [{"type": "text", "text": "Second"}]},
    ])
    assert [message.id for message in recovery_user_messages(inp, "native")] == ["new-1", "new-2"]

@pytest.mark.asyncio
async def test_failed_queued_user_turn_stops_later_prompts():
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    from claude_agent_sdk import ResultMessage
    adapter = ClaudeAgentAdapter("test")
    recovery = RecoveryRun(None, request())
    calls = []
    def result(error=False):
        return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=error, num_turns=1, session_id="native")
    async def initial(): yield result()
    class Worker:
        async def query(self, prompt, session_id):
            calls.append(prompt)
            yield result(True)
    events = [e async for e in adapter._resume_with_user_input(Worker(), initial(), recovery, "thread", "profile", ["First", "Second"])]
    assert calls == ["First"]
    assert events[-1].is_error
    await adapter.shutdown()

@pytest.mark.asyncio
async def test_middleware_error_metadata_survives_restart(make_input):
    pending = {"id": "mcp-call", "name": "mcp__ag_ui__draw", "input": {}}
    inp = make_input(messages=[{"id": "result", "role": "tool", "toolCallId": pending["id"], "content": "original MCP error", "metadata": {"ag-ui:tool-result": {"error": ""}}}])
    run = RecoveryRun(SessionBinding("native", "profile", pending), inp)
    await run.hook({"hook_event_name": "PreToolUse", "tool_use_id": pending["id"], "tool_name": pending["name"], "tool_input": {}}, pending["id"], {})
    assert run.resolve_frontend_result("draw", {}) == {"content": "original MCP error", "error": ""}
    with pytest.raises(ValueError, match="no matching resumed result"):
        run.resolve_frontend_result("draw", {})

@pytest.mark.asyncio
async def test_batch_retains_all_siblings_and_refuses_cold_continuation():
    run = RecoveryRun(None, request(), ['Bash'])
    calls = [{**PENDING, 'id': f'batch-{i}', 'input': {'command': f'echo {i}'}} for i in range(3)]
    for call in calls:
        await run.hook(hook_input(tool_use_id=call['id'], tool_input=call['input']), call['id'], {})
    run.observe('native', 'profile', event('tool_deferred', calls[-1]))
    assert run.binding.unsupported_pending_tools == calls
    with pytest.raises(ValueError, match='multiple pending tool calls'):
        run.assert_supported()
    saved = deepcopy(run.binding)
    with pytest.raises(ValueError, match='multiple pending tool calls'):
        RecoveryRun(saved, request())
    assert saved == run.binding


def test_unresolved_native_siblings_exclude_completed_empty_results():
    from ag_ui_claude_sdk.recovery import unresolved_tool_uses
    history = [SimpleNamespace(message={'content': [{'type': 'tool_use', **PENDING, 'id': f'call-{i}'} for i in range(3)]}),
               SimpleNamespace(message={'content': [{'type': 'tool_result', 'tool_use_id': 'call-0', 'content': ''}]})]
    assert [call['id'] for call in unresolved_tool_uses(history)] == ['call-1', 'call-2']
    history.append(SimpleNamespace(message={'content': [{'type': 'tool_result', 'tool_use_id': 'call-1', 'content': ''}]}))
    assert [call['id'] for call in unresolved_tool_uses(history)] == ['call-2']

@pytest.mark.asyncio
@pytest.mark.parametrize('native', [False, True])
async def test_legacy_batch_is_saved_and_rejected_before_query(monkeypatch, native):
    from ag_ui.core import RunAgentInput
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    import ag_ui_claude_sdk.adapter as module
    import claude_agent_sdk
    calls = [{**PENDING, 'id': f'batch-{i}', 'name': 'Bash' if native else 'mcp__ag_ui__confirm'} for i in range(3)]
    class Store:
        value = SessionBinding('original', 'profile', pending=calls[-1])
        async def load(self, thread): return deepcopy(self.value)
        async def save(self, thread, binding): self.value = deepcopy(binding)
    store = Store()
    monkeypatch.setattr(claude_agent_sdk, 'get_session_messages', lambda *a, **k: [SimpleNamespace(message={'content': [{'type': 'tool_use', **call} for call in calls]})])
    def unexpected_worker(*args, **kwargs):
        pytest.fail('Blocked batch must not start an SDK worker')
    monkeypatch.setattr(module, 'SessionWorker', unexpected_worker)
    submitted = RunAgentInput(thread_id='thread', run_id='run', state={}, tools=[], context=[], forwarded_props={},
        messages=([{'id': 'answer', 'role': 'tool', 'toolCallId': calls[-1]['id'], 'content': 'actual result'}] if not native else []) + [{'id': 'next', 'role': 'user', 'content': 'Keep this next message'}],
        resume=[{'interruptId': calls[-1]['id'], 'status': 'resolved', 'payload': {'behavior': 'allow'}}] if native else [])
    before = submitted.model_dump()
    async def profile(name): return {}
    adapter = ClaudeAgentAdapter('test', session_binding_store=store, resolve_profile=profile)
    events = [e async for e in adapter.run(submitted)]
    assert events[-1].type == 'RUN_ERROR'
    assert 'multiple pending tool calls' in events[-1].message
    assert store.value.unsupported_pending_tools == calls
    assert store.value.pending == calls[-1]
    assert store.value.session_id == 'original'
    assert submitted.model_dump() == before

@pytest.mark.asyncio
async def test_unresolved_batch_is_retained_on_sdk_error():
    run = RecoveryRun(None, request(), ['Bash'])
    for call_id in ('first', 'second'):
        await run.hook(hook_input(tool_use_id=call_id), call_id, {})
    run.observe('native', 'profile', event(error=True))
    assert [call['id'] for call in run.binding.unsupported_pending_tools] == ['first', 'second']
    with pytest.raises(ValueError, match='multiple pending tool calls'):
        run.assert_supported()

@pytest.mark.asyncio
@pytest.mark.parametrize('cancelled', [False, True])
async def test_interrupted_batch_survives_fresh_adapter(monkeypatch, cancelled):
    import asyncio
    from dataclasses import asdict
    from ag_ui.core import RunAgentInput
    from claude_agent_sdk import SystemMessage
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    import ag_ui_claude_sdk.adapter as module
    ready = asyncio.Event()
    calls = [{**PENDING, 'id': f'interrupted-{i}'} for i in range(2)]
    class Store:
        value = None
        async def load(self, thread): return SessionBinding(**deepcopy(self.value)) if self.value else None
        async def save(self, thread, binding): self.value = asdict(binding)
    store = Store()
    queries = []
    class Worker:
        def __init__(self, thread, options): self.options = options
        async def start(self): pass
        async def stop(self): pass
        def is_alive(self): return True
        async def query(self, prompt, session_id):
            queries.append(prompt)
            yield SystemMessage(subtype='init', data={'session_id': 'original'})
            for call in calls:
                await self.options.hooks['PreToolUse'][-1].hooks[0](hook_input(session_id='original', tool_use_id=call['id']), call['id'], {})
            ready.set()
            if cancelled: await asyncio.Event().wait()
            else: raise RuntimeError('transport disconnected before result')
    monkeypatch.setattr(module, 'SessionWorker', Worker)
    async def profile(name): return {}
    def agent(): return ClaudeAgentAdapter('test', session_binding_store=store, resolve_profile=profile, defer_tools=['Bash'])
    initial = RunAgentInput(thread_id='thread', run_id='run', state=None, tools=[], context=[], forwarded_props={}, messages=[{'id':'user','role':'user','content':'start'}])
    first = agent()
    async def consume(): return [e async for e in first.run(initial)]
    task = asyncio.create_task(consume())
    await ready.wait()
    if cancelled:
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
    else: await task
    assert store.value['unsupported_pending_tools'] == calls
    before = deepcopy(store.value)
    second = agent()
    events = [e async for e in second.run(initial.model_copy(update={'run_id': 'fresh'}))]
    assert events[-1].type == 'RUN_ERROR'
    assert 'multiple pending tool calls' in events[-1].message
    assert store.value == before
    assert len(queries) == 1
    await first.shutdown()
    await second.shutdown()



@pytest.mark.asyncio
@pytest.mark.parametrize('ending', ['success', 'sdk-error', 'exception'])
@pytest.mark.parametrize('child_order', ['none', 'first', 'last'])
async def test_completed_batch_does_not_block_next_turn(monkeypatch, ending, child_order):
    import json
    from dataclasses import asdict
    from ag_ui.core import RunAgentInput
    from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, UserMessage, ToolResultBlock, ToolUseBlock
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    import ag_ui_claude_sdk.adapter as module
    import claude_agent_sdk
    calls = [{**PENDING, 'id': f'completed-{i}'} for i in range(2)]
    child = {'id': 'completed-child', 'name': 'Read', 'input': {'file_path': 'example.txt'}}
    child_result = UserMessage(content=[ToolResultBlock(tool_use_id=child['id'],
        content='Child completed', is_error=False)], parent_tool_use_id='parent-agent')
    queries = []
    class Store:
        value = None
        async def load(self, thread): return SessionBinding(**json.loads(self.value)) if self.value else None
        async def save(self, thread, value): self.value = json.dumps(asdict(value))
    store = Store()
    class Worker:
        def __init__(self, thread, options): self.options = options
        async def start(self): pass
        async def stop(self): pass
        def is_alive(self): return True
        async def query(self, prompt, session_id):
            queries.append(prompt)
            yield SystemMessage(subtype='init', data={'session_id': 'original'})
            if len(queries) == 1:
                for call in calls:
                    await self.options.hooks['PreToolUse'][-1].hooks[0](
                        hook_input(session_id='original', tool_use_id=call['id']), call['id'], {})
                if child_order != 'none':
                    yield AssistantMessage(content=[ToolUseBlock(**child)], model='synthetic', parent_tool_use_id='parent-agent')
                if child_order == 'first': yield child_result
                yield UserMessage(content=[ToolResultBlock(tool_use_id=call['id'],
                    content='Actually completed', is_error=False) for call in calls])
                if child_order == 'last': yield child_result
                if ending == 'exception': raise RuntimeError('transport disconnected after completion')
            yield ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1,
                is_error=len(queries) == 1 and ending == 'sdk-error',
                num_turns=1, session_id='original')
    monkeypatch.setattr(module, 'SessionWorker', Worker)
    monkeypatch.setattr(claude_agent_sdk, 'get_session_info', lambda *a, **k: SimpleNamespace(session_id='original'))
    async def profile(name): return {}
    def agent(): return ClaudeAgentAdapter('test', session_binding_store=store,
        resolve_profile=profile, defer_tools=['Bash'])
    initial = RunAgentInput(thread_id='thread', run_id='run', state=None, tools=[],
        context=[], forwarded_props={}, messages=[{'id':'start','role':'user','content':'start'}])
    first = agent()
    _ = [e async for e in first.run(initial)]
    await first.shutdown()
    saved = json.loads(store.value)
    assert saved['pending'] is None
    second = agent()
    followup = initial.model_copy(update={'run_id':'fresh', 'messages':[
        type(initial.messages[0]).model_validate({'id':'next','role':'user','content':'new user turn'})]})
    events = [e async for e in second.run(followup)]
    await second.shutdown()
    assert events[-1].type == 'RUN_FINISHED'
    assert len(queries) == 2
    assert saved['unsupported_pending_tools'] is None



@pytest.mark.parametrize('parent_deferred', [False, True])
def test_unresolved_child_survives_parent_completion_and_restart(parent_deferred):
    import json
    from dataclasses import asdict
    run = RecoveryRun(None, request())
    run.observe_child_tool(PENDING, 'parent-agent')
    run.observe_tool_result('parent-agent')
    run.observe_tool_result(PENDING['id'], 'wrong-parent')
    run.observe('native', 'profile', event('tool_deferred', {**PENDING, 'id': 'parent-read'}) if parent_deferred else event())
    assert {**PENDING, 'parentToolUseId': 'parent-agent'} in run.binding.unsupported_pending_tools
    with pytest.raises(ValueError, match='child deferral recovery is unsupported'):
        run.assert_supported()
    with pytest.raises(ValueError, match='child deferral recovery is unsupported'):
        RecoveryRun(SessionBinding(**json.loads(json.dumps(asdict(run.binding)))), request('allow'))


def test_correlated_child_result_allows_parent_completion():
    run = RecoveryRun(None, request())
    run.observe_child_tool(PENDING, 'parent-agent')
    run.observe_tool_result(PENDING['id'], 'parent-agent')
    run.observe('native', 'profile', event())
    run.assert_supported()
    assert run.binding.unsupported_pending_tools is None

@pytest.mark.asyncio
@pytest.mark.parametrize('resolved', [False, True])
async def test_adapter_persists_child_diagnostics_before_parent_completion(resolved):
    from ag_ui_claude_sdk.adapter import ClaudeAgentAdapter
    from claude_agent_sdk import AssistantMessage, UserMessage, ToolUseBlock, ToolResultBlock, SystemMessage, ResultMessage
    saved = []
    class Store:
        async def save(self, thread_id, binding):
            saved.append(deepcopy(binding))
    adapter = ClaudeAgentAdapter(name="test", session_binding_store=Store(), resolve_profile=lambda _: {})
    run = RecoveryRun(None, request())
    async def stream():
        yield SystemMessage(subtype='init', data={'session_id': 'native'})
        yield AssistantMessage(content=[ToolUseBlock(**PENDING)], model='synthetic', parent_tool_use_id='parent-agent')
        yield UserMessage(content=[ToolResultBlock(tool_use_id='parent-agent', content='Agent launched')])
        yield SystemMessage(subtype='task_notification', data={'status': 'completed', 'tool_use_id': 'parent-agent'})
        if resolved:
            yield UserMessage(content=[ToolResultBlock(tool_use_id=PENDING['id'], content='actual result')], parent_tool_use_id='parent-agent')
        yield ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id='native')
    if resolved:
        assert len([m async for m in adapter._observe_recovery(stream(), run, 'public', 'profile')]) == 6
        assert saved[-1].unsupported_pending_tools is None
    else:
        with pytest.raises(ValueError, match='child deferral recovery is unsupported'):
            [m async for m in adapter._observe_recovery(stream(), run, 'public', 'profile')]
        assert saved[-1].unsupported_pending_tools == [{**PENDING, 'parentToolUseId': 'parent-agent'}]


def test_child_deferral_is_not_promoted_to_parent_approval():
    run = RecoveryRun(None, request())
    run.observe_child_tool(PENDING, 'parent-agent')
    run.observe('native', 'profile', event('tool_deferred', deepcopy(PENDING)))
    assert run.binding.pending is None
    assert run.binding.unsupported_pending_tools == [{**PENDING, 'parentToolUseId': 'parent-agent'}]
    with pytest.raises(ValueError, match='child deferral recovery is unsupported'):
        run.assert_supported()
