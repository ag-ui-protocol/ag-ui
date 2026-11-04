import json
import pytest
from ag_ui_claude_sdk.native_history import NativeHistory
SESSION = '11111111-1111-4111-8111-111111111111'
def fixture(tmp_path):
    folder = tmp_path / 'project' / SESSION / 'subagents'
    folder.mkdir(parents=True)
    def row(call, name, child=False):
        return dict(type='assistant', uuid=call+'-row', version='2.1.306', sessionId=SESSION,
                    **({'agentId':'abc123'} if child else {}),
                    message={'role':'assistant','content':[dict(type='tool_use',id=call,name=name,input={'file_path':'fixture'})]})
    (folder.parent.parent / (SESSION+'.jsonl')).write_text(json.dumps(row('parent','Agent'))+'\n')
    path=folder/'agent-abc123.jsonl';path.write_text(json.dumps(row('question','Read',True))+'\n')
    return path, NativeHistory(tmp_path,SESSION,['Read'])
def test_reconstruct_and_answer(tmp_path):
    path, history=fixture(tmp_path);before=path.read_bytes();checkpoint=history.inspect()
    assert checkpoint['pending'][0]['id']=='question'
    assert NativeHistory(tmp_path,SESSION,['Read']).inspect()==checkpoint
    assert path.read_bytes()==before
    history.answer(checkpoint, {'question':{'content':'ACTUAL RESULT','is_error':False}})
    assert NativeHistory(tmp_path,SESSION,['Read']).inspect()['pending']==[]
    with pytest.raises(ValueError):history.answer(checkpoint,{'question':{'content':'duplicate'}})
def test_ambiguous_children(tmp_path):
    path, history=fixture(tmp_path)
    path.with_name('agent-def456.jsonl').write_bytes(path.read_bytes())
    with pytest.raises(ValueError,match='one child|identity mismatch'):history.inspect()
def test_path_traversal(tmp_path):
    with pytest.raises(ValueError,match='session'):NativeHistory(tmp_path,'../escape',['Read'])
def test_repair_only_after_child_completion(tmp_path):
    path, history=fixture(tmp_path);checkpoint=history.inspect()
    history.answer(checkpoint,{'question':{'content':'DENIED','is_error':True}})
    with pytest.raises(ValueError,match='not completed'):history.repair(checkpoint)
    with path.open('a') as f:f.write(json.dumps(dict(type='assistant',uuid='final-row',sessionId=SESSION,agentId='abc123',version='2.1.306',message={'role':'assistant','stop_reason':'end_turn','content':[{'type':'text','text':'Child respected the denial'}]}))+'\n')
    history.repair(checkpoint)
    assert history.inspect() is None
    assert 'Child respected the denial' in checkpoint['parentPath'].read_text()
    assert '"is_error": true' in path.read_text()
def test_empty_completed_response(tmp_path):
    path, history=fixture(tmp_path);checkpoint=history.inspect()
    history.answer(checkpoint,{'question':{'content':''}})
    with path.open('a') as f:f.write(json.dumps(dict(type='assistant',uuid='empty-final',version='2.1.306',message={'role':'assistant','stop_reason':'end_turn','content':[]}))+'\n')
    assert history.completed(checkpoint)
    history.repair(checkpoint)
    assert history.inspect() is None

@pytest.mark.asyncio
@pytest.mark.parametrize('placeholder', [False, True])
async def test_cold_recovery_rejects_lost_bridge_result(tmp_path, placeholder, monkeypatch):
    from unittest.mock import AsyncMock
    from claude_agent_sdk import ClaudeAgentOptions
    from ag_ui.core import RunAgentInput
    from ag_ui_claude_sdk.native_recovery import NativeChildRecovery, NativeChildRecoveryConfig
    path, history = fixture(tmp_path)
    checkpoint = history.inspect()
    history.answer(checkpoint, {'question': {'content': 'REAL RESULT'}})
    with path.open('a') as f:
        f.write(json.dumps(dict(type='assistant', uuid='final', message=dict(role='assistant', stop_reason='end_turn', content=[dict(type='text', text='DONE')])))+'\n')
    with checkpoint['parentPath'].open('a') as f:
        f.write(json.dumps(dict(type='assistant', uuid='bridge', message=dict(role='assistant', content=[dict(type='tool_use', id='bridge-call', name='SendMessage', input=dict(to=checkpoint['childId'], message='Continue the original task using the recorded tool results. Do not repeat completed tools.'))])))+'\n')
        if placeholder:
            f.write(json.dumps(dict(type='user', uuid='unknown', message=dict(role='user', content=[dict(type='tool_result', tool_use_id='bridge-call', is_error=True, content='[Tool call interrupted: outcome unknown]')])))+'\n')
    def unexpected(*args, **kwargs):
        raise AssertionError('Unexpected SDK startup')
    monkeypatch.setattr(NativeChildRecovery, 'execute', unexpected)
    before = checkpoint['parentPath'].read_bytes()
    release = AsyncMock()
    execute = AsyncMock()
    recovery = NativeChildRecovery(NativeChildRecoveryConfig(str(tmp_path), ['Read'], execute, AsyncMock(return_value=release)))
    input_data = RunAgentInput(thread_id='thread', run_id='run', messages=[], tools=[], context=[], state={}, forwarded_props={})
    with pytest.raises(ValueError, match='Unresolved recovery tool result'):
        async for _ in recovery.run(input_data, ClaudeAgentOptions(resume=SESSION), 'continue'):
            pass
    execute.assert_not_called()
    release.assert_awaited_once()
    assert checkpoint['parentPath'].read_bytes() == before
    history.settle_bridge(checkpoint, {'bridge-call': {'content': 'ACTUAL SEND RESPONSE'}})
    history.repair(checkpoint)
    assert history.inspect() is None

def test_diagnostic_calls_and_results_are_preserved_not_interpreted(tmp_path):
    path, history = fixture(tmp_path)
    checkpoint = history.inspect()
    snapshots = {}
    for file in [checkpoint['parentPath'], path]:
        call = json.loads(file.read_text())['message']['content'][0]
        diagnostic = [
            dict(type='api-request-blob', message=dict(role='assistant', content=[dict(**call, caller=dict(type='direct'))])),
            dict(type='api-request-blob', message=dict(role='user', content=[dict(type='tool_result', tool_use_id=call['id'], content='DIAGNOSTIC ONLY')])),
            dict(type='api-request-blob', message=dict(role='user', content=[dict(type='tool_result', tool_use_id=call['id'], content='[Tool call interrupted: diagnostic]', is_error=True)])),
        ]
        snapshots[file] = diagnostic
        with file.open('a') as f:
            f.write(''.join(json.dumps(r)+'\n' for r in diagnostic))
    assert [c['id'] for c in history.inspect()['pending']] == ['question']
    history.answer(checkpoint, {'question': {'content': 'ACTUAL'}})
    with path.open('a') as f:
        f.write(json.dumps(dict(type='assistant', uuid='final', message=dict(role='assistant', stop_reason='end_turn', content=[dict(type='text', text='DONE')])) )+'\n')
    history.repair(checkpoint)
    assert history.inspect() is None
    for file, diagnostic in snapshots.items():
        assert [r for r in map(json.loads, file.read_text().splitlines()) if r['type'] == 'api-request-blob'] == diagnostic

def test_nested_repair_preserves_sidechain_identity(tmp_path):
    path, history=fixture(tmp_path)
    original=json.loads(path.read_text());original['isSidechain']=True
    original['message']['content']=[dict(type='tool_use',id='inner',name='Agent',input={})]
    path.write_text(json.dumps(original)+'\n')
    path.with_suffix('.meta.json').write_text(json.dumps(dict(toolUseId='parent')))
    leaf_path=path.with_name('agent-leaf.jsonl')
    leaf_path.write_text(json.dumps({**original,'uuid':'leaf-row','agentId':'leaf','message':dict(role='assistant',content=[dict(type='tool_use',id='leaf-read',name='Read',input={})])})+'\n')
    leaf_path.with_suffix('.meta.json').write_text(json.dumps(dict(toolUseId='inner',parentAgentId='abc123')))
    checkpoints=history.children()
    assert next(c for c in checkpoints if c['childId']=='abc123')['dependencies']==['inner']
    leaf=next(c for c in checkpoints if c['childId']=='leaf')
    history.answer(leaf,{'leaf-read':dict(content='ACTUAL')})
    with leaf_path.open('a') as f:f.write(json.dumps(dict(type='assistant',uuid='leaf-final',agentId='leaf',message=dict(role='assistant',stop_reason='end_turn',content=[dict(type='text',text='LEAF DONE')])) )+'\n')
    history.repair(leaf)
    result=json.loads(path.read_text().splitlines()[-1])
    assert result['agentId']=='abc123' and result['isSidechain'] is True
    assert result['sourceToolAssistantUUID']==original['uuid']
    assert result['message']['content'][0]['tool_use_id']=='inner'
    assert [c['childId'] for c in history.children()]==['abc123']
    assert len(history.children(True))==2

def test_metadata_parent_must_match_canonical_owner(tmp_path):
    path, history = fixture(tmp_path)
    path.with_suffix('.meta.json').write_text(json.dumps(dict(toolUseId='parent',parentAgentId='other')))
    with pytest.raises(ValueError, match='parent identity mismatch'):
        history.children()

@pytest.mark.asyncio
async def test_automatic_state_validates_first_and_only_acknowledges_once(tmp_path):
    from unittest.mock import AsyncMock
    from claude_agent_sdk import ClaudeAgentOptions
    from ag_ui.core import RunAgentInput
    from ag_ui_claude_sdk.native_recovery import NativeChildRecovery, NativeChildRecoveryConfig
    path, _ = fixture(tmp_path)
    row=json.loads(path.read_text())
    row['message']['content'].append(dict(type='tool_use', id='state', name='internal_state', input=dict(state_updates=dict(count=2))))
    path.write_text(json.dumps(row)+'\n'); before=path.read_bytes()
    automatic=AsyncMock(return_value=dict(content='Actual acknowledgement'))
    execute=AsyncMock();release=AsyncMock()
    config=NativeChildRecoveryConfig(str(tmp_path), ['Read'], execute, AsyncMock(return_value=release))
    data=dict(thread_id='t',run_id='r',messages=[],tools=[],context=[],state={},forwarded_props={})
    for key in ['unknown','state']:
        recovery=NativeChildRecovery(config,dict(internal_state=automatic))
        with pytest.raises(ValueError):
            async for _ in recovery.run(RunAgentInput(**data,resume=[dict(interruptId=key,status='resolved',payload=dict(behavior='allow'))]),ClaudeAgentOptions(resume=SESSION),'continue'): pass
        assert path.read_bytes()==before
    automatic.assert_not_awaited();execute.assert_not_awaited()
    for _ in range(2):
        recovery=NativeChildRecovery(config,dict(internal_state=automatic))
        async for _ in recovery.run(RunAgentInput(**data),ClaudeAgentOptions(resume=SESSION),'continue'): pass
        assert [i['id'] for i in recovery.outcome['interrupts']]==['question']
    automatic.assert_awaited_once();execute.assert_not_awaited()
    assert release.await_count==4

def test_retires_answered_defer_with_provenance(tmp_path):
    path,history=fixture(tmp_path)
    marker=dict(type='attachment',uuid='deferred',parentUuid='question-row',attachment=dict(type='hook_deferred_tool',toolUseID='question'))
    with path.open('a') as f:
        f.write(json.dumps(marker)+'\n'+json.dumps(dict(type='attachment',uuid='snapshot',parentUuid='deferred',attachment=dict(type='prompt_snapshot')))+'\n')
    history.answer(history.inspect(),dict(question=dict(content='ACTUAL')))
    rows=list(map(json.loads,path.read_text().splitlines()))
    assert not any(r.get('attachment',{}).get('type')=='hook_deferred_tool' for r in rows)
    assert next(r for r in rows if r.get('uuid')=='snapshot')['parentUuid']=='question-row'
    assert rows[-1]['agUiResolvedDeferrals']==[marker]
    assert rows[-1]['message']['content'][0]['content']=='ACTUAL'

@pytest.mark.asyncio
async def test_retransmission_cannot_change_error_status(tmp_path):
    from unittest.mock import AsyncMock
    from claude_agent_sdk import ClaudeAgentOptions
    from ag_ui.core import RunAgentInput
    from ag_ui_claude_sdk.native_recovery import NativeChildRecovery, NativeChildRecoveryConfig
    _,history=fixture(tmp_path)
    history.answer(history.inspect(),dict(question=dict(content='ACTUAL')))
    recovery=NativeChildRecovery(NativeChildRecoveryConfig(str(tmp_path),['Read'],AsyncMock(),AsyncMock(return_value=AsyncMock())))
    data=RunAgentInput(thread_id='t',run_id='r',messages=[dict(id='result',role='tool',toolCallId='question',content='ACTUAL',error='changed')],tools=[],context=[],state={},forwarded_props={})
    with pytest.raises(ValueError,match='differs from canonical history'):
        async for _ in recovery.run(data,ClaudeAgentOptions(resume=SESSION),'continue'):pass

@pytest.mark.parametrize('variant', ['valid', 'wrong-target', 'wrong-message', 'no-receipt', 'failed-receipt', 'no-prompt'])
def test_completed_child_supersedes_only_verified_recovery_delivery(tmp_path, variant):
    path, history = fixture(tmp_path)
    cp = history.inspect()
    history.answer(cp, {'question': {'content': 'ACTUAL'}})
    with path.open('a') as f:
        f.write(json.dumps(dict(type='assistant', uuid='final', message=dict(role='assistant', stop_reason='end_turn', content=[dict(type='text', text='DONE')])))+'\n')
    message = 'Continue the original task using the recorded tool results. Do not repeat completed tools.'
    unknown = dict(type='tool_result', tool_use_id='old-bridge', is_error=True, content='[Tool call interrupted: outcome unknown]')
    records = []
    for key in ['old-bridge', 'new-bridge']:
        target = 'different-child' if variant == 'wrong-target' and key == 'new-bridge' else cp['childId']
        text = 'another message' if variant == 'wrong-message' and key == 'new-bridge' else message
        records.extend([dict(type='user', uuid=key+'-prompt', message=dict(role='user', content='not recovery' if variant == 'no-prompt' else f'Resume child {target} with SendMessage, message exactly: {text}')), dict(type='assistant', uuid=key, message=dict(role='assistant', content=[dict(type='tool_use', id=key, name='SendMessage', input=dict(to=target, message=text))]))])
        if key == 'old-bridge':
            result = unknown
        else:
            if variant == 'no-receipt':continue
            result = dict(type='tool_result', tool_use_id=key, is_error=variant == 'failed-receipt', content=json.dumps(dict(success=True,resumedAgentId=target)))
        records.append(dict(type='user',uuid=key+'-result',message=dict(role='user',content=[result])))
    with cp['parentPath'].open('a') as f:f.write(''.join(json.dumps(r)+'\n' for r in records))
    before = cp['parentPath'].read_bytes()
    if variant != 'valid':
        with pytest.raises(ValueError, match='Unresolved recovery'):history.repair(cp)
        assert cp['parentPath'].read_bytes() == before
        return
    history.repair(cp)
    NativeHistory(tmp_path,SESSION,['Read']).assert_root_ready()
    assert history.inspect() is None
    saved = [b for r in map(json.loads,cp['parentPath'].read_text().splitlines()) for b in r.get('message',{}).get('content',[]) if isinstance(b,dict) and b.get('tool_use_id')=='old-bridge']
    assert saved == [unknown]
