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
    with pytest.raises(ValueError,match='one child'):history.inspect()
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
