import asyncio
import json
import sys
import uuid
from pathlib import Path
from ag_ui.core import RunAgentInput
from ag_ui_claude_sdk import ClaudeAgentAdapter, NativeChildRecoveryConfig
from claude_agent_sdk import ClaudeAgentOptions, AgentDefinition
c=json.loads(Path(sys.argv[1]).read_text())
async def acquire(session):
    # Disposable workers are serialized by the supervisor; production supplies an exclusive lease.
    async def release(): pass
    return release
async def execute(call,key):
    if call['name']!='Read' or call['input']['file_path']!=c['root']+'/fixture.txt':raise ValueError('Unexpected tool')
    with open(c['root']+'/executions.log','a') as f:f.write(key+'\n')
    return {'content':Path(call['input']['file_path']).read_text()}
async def main():
    adapter=ClaudeAgentAdapter('standalone',query_timeout_seconds=10,options=ClaudeAgentOptions(stderr=lambda line:print(line,file=sys.stderr),cwd=c['root'],env=c['env'],setting_sources=[],model='claude-sonnet-4-6',tools=['Agent','SendMessage','Read','Write'],allowed_tools=['Agent','SendMessage','Write'],agents={name: AgentDefinition(**definition) for name, definition in c['agents'].items()} if c.get('agents') else {'verifier':AgentDefinition(description='Read fixture',prompt='Read fixture only',tools=['Read'])},session_id=c['session'] if c['phase']=='start' else None),native_child_recovery=NativeChildRecoveryConfig(c['root']+'/config/projects',['Read'],execute,acquire,1.5))
    data={'threadId':'standalone','runId':str(uuid.uuid4()),'messages':[{'id':str(uuid.uuid4()),'role':'user','content':'Read the fixture with a verifier child.'}],'tools':[],'context':[],'state':{},'forwardedProps':{} if c['phase']=='start' else {'resume':c['session']}}
    if c['phase']=='answer':data['resume']=[{'interruptId':'original_child0','status':'resolved','payload':{'behavior':c['decision']}}]
    data = c.get('input', data)
    events=[e.model_dump(by_alias=True,exclude_none=True) async for e in adapter.run(RunAgentInput.model_validate(data))]
    print('EVENTS '+json.dumps(events,default=str),flush=True)
    if any(e['type']=='RUN_ERROR' for e in events):raise SystemExit(1)
asyncio.run(main())
