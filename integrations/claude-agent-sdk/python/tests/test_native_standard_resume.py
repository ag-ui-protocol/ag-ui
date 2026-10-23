import json
from unittest.mock import AsyncMock
import pytest
from claude_agent_sdk import ClaudeAgentOptions
from ag_ui.core import RunAgentInput
from ag_ui_claude_sdk.native_recovery import NativeChildRecovery, NativeChildRecoveryConfig
SESSION='11111111-1111-4111-8111-111111111111'

@pytest.fixture
def standard_fixture(tmp_path,monkeypatch):
    folder=tmp_path/'project';folder.mkdir();path=folder/(SESSION+'.jsonl')
    calls=[dict(type='tool_use',id='native',name='Read',input=dict(file_path='fixture')),dict(type='tool_use',id='frontend',name='mcp__ag_ui__chart',input=dict(value=7))]
    path.write_text(json.dumps(dict(type='assistant',uuid='call-row',sessionId=SESSION,version='2.1.306',message=dict(role='assistant',content=calls)))+'\n')
    executor=AsyncMock(return_value=dict(content='ACTUAL_NATIVE'))
    config=NativeChildRecoveryConfig(str(tmp_path),['Read'],executor,AsyncMock(return_value=AsyncMock()))
    async def complete(*args,**kwargs):
        if False:yield
    monkeypatch.setattr(NativeChildRecovery,'execute',complete)
    data=dict(thread_id=SESSION,run_id='run',messages=[],tools=[dict(name='chart',description='Render chart',parameters=dict(type='object',properties=dict(value=dict(type='number'))))],state={},context=[],forwarded_props={})
    return path,executor,config,data

@pytest.mark.asyncio
@pytest.mark.parametrize('cancelled',[False,True])
async def test_standard_frontend_pair_preserves_one_result(standard_fixture,cancelled):
    path,executor,config,data=standard_fixture
    recovery=NativeChildRecovery(config)
    async for _ in recovery.run(RunAgentInput(**data),ClaudeAgentOptions(resume=SESSION),'continue'):pass
    assert [(i['id'],i['reason']) for i in recovery.outcome['interrupts']]==[('native','tool_approval'),('frontend','tool_call')]
    payload=dict(displayed=True,value=7)
    content=json.dumps(dict(status='cancelled') if cancelled else payload,separators=(',',':'))
    data['messages']=[dict(id='frontend-result',role='tool',toolCallId='frontend',content=content)]
    data['resume']=[dict(interruptId='native',status='resolved',payload=dict(behavior='allow')),dict(interruptId='frontend',status='cancelled') if cancelled else dict(interruptId='frontend',status='resolved',payload=payload)]
    for _ in range(2):
        recovery=NativeChildRecovery(config)
        async for _ in recovery.run(RunAgentInput(**data),ClaudeAgentOptions(resume=SESSION),'continue'):pass
    executor.assert_awaited_once()
    results=[b for r in map(json.loads,path.read_text().splitlines()) if r['type']=='user' for b in r['message']['content'] if b.get('tool_use_id')=='frontend']
    assert results==[dict(type='tool_result',tool_use_id='frontend',content=content,is_error=cancelled)]

@pytest.mark.asyncio
@pytest.mark.parametrize('kind',['conflict','missing','native-pair','boolean-number'])
async def test_standard_pair_rejected_before_native_effect(standard_fixture,kind):
    path,executor,config,data=standard_fixture;before=path.read_bytes()
    payload=dict(displayed=True,value=7)
    if kind!='missing':data['messages']=[dict(id='frontend-result',role='tool',toolCallId='frontend',content=json.dumps(dict(displayed=False) if kind=='conflict' else dict(displayed=1,value=7) if kind=='boolean-number' else payload))]
    if kind=='native-pair':data['messages'].append(dict(id='native-result',role='tool',toolCallId='native',content='UNTRUSTED'))
    data['resume']=[dict(interruptId='native',status='resolved',payload=dict(behavior='allow')),dict(interruptId='frontend',status='resolved',payload=payload)]
    with pytest.raises(ValueError):
        async for _ in NativeChildRecovery(config).run(RunAgentInput(**data),ClaudeAgentOptions(resume=SESSION),'continue'):pass
    executor.assert_not_awaited();assert path.read_bytes()==before

@pytest.mark.asyncio
async def test_retry_saved_answers_after_downstream_timeout(standard_fixture, monkeypatch):
    path, executor, config, data = standard_fixture
    payload = dict(displayed=True, value=7)
    data['messages'] = [dict(id='frontend-result', role='tool', toolCallId='frontend', content=json.dumps(payload))]
    data['resume'] = [dict(interruptId='native', status='resolved', payload=dict(behavior='allow')), dict(interruptId='frontend', status='resolved', payload=payload)]
    async def timeout(*args, **kwargs):
        raise RuntimeError('downstream timeout after saved answers')
        yield
    monkeypatch.setattr(NativeChildRecovery, 'execute', timeout)
    with pytest.raises(RuntimeError, match='downstream timeout'):
        async for _ in NativeChildRecovery(config).run(RunAgentInput(**data), ClaudeAgentOptions(resume=SESSION), 'continue'):
            pass
    executor.assert_awaited_once()
    before = path.read_bytes()
    # The client retained both the old approval and the streamed canonical result.
    data['messages'].append(dict(id='native-result', role='tool', toolCallId='native', content='ACTUAL_NATIVE'))
    async def complete(*args, **kwargs):
        if False:
            yield
    monkeypatch.setattr(NativeChildRecovery, 'execute', complete)
    async for _ in NativeChildRecovery(config).run(RunAgentInput(**data), ClaudeAgentOptions(resume=SESSION), 'continue'):
        pass
    executor.assert_awaited_once()
    assert path.read_bytes() == before
