# Localhost fake-provider probe: only synthetic files, no real model calls.
import asyncio, json, os, sys, tempfile, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from claude_agent_sdk import get_session_messages, query, ClaudeAgentOptions, HookMatcher, ResultMessage, SystemMessage
root=Path(tempfile.mkdtemp(prefix='pni659-python-native-'))
(root/'fixture.txt').write_text('REAL_PYTHON_RESULT')
class Handler(BaseHTTPRequestHandler):
    calls=0
    def log_message(self,*args): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if 'count_tokens' in self.path:
            self.send_response(200);self.end_headers();self.wfile.write(b'{"input_tokens":10}');return
        Handler.calls+=1
        answered='tool_result' in json.dumps(body.get('messages'))
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        def send(t,**data): self.wfile.write(('event: '+t+'\ndata: '+json.dumps({'type':t,**data})+'\n\n').encode())
        send('message_start',message={'id':f'msg_python_{Handler.calls}','type':'message','role':'assistant','model':'claude-sonnet-4-6','content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':0}})
        send('content_block_start',index=0,content_block={'type':'text','text':''} if answered else {'type':'tool_use','id':'toolu_python_original','name':'mcp__ag_ui__confirm','input':{}})
        send('content_block_delta',index=0,delta={'type':'text_delta','text':'Synthetic completion'} if answered else {'type':'input_json_delta','partial_json':json.dumps({'value':'test'})})
        send('content_block_stop',index=0)
        send('message_delta',delta={'stop_reason':'end_turn' if answered else 'tool_use','stop_sequence':None},usage={'output_tokens':10})
        send('message_stop')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
env={'HOME':str(root),'CLAUDE_CONFIG_DIR':str(root/'config'),'ANTHROPIC_API_KEY':'synthetic-not-a-secret','ANTHROPIC_AUTH_TOKEN':'','ANTHROPIC_BASE_URL':f'http://127.0.0.1:{server.server_port}','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_TELEMETRY':'1'}
os.environ['CLAUDE_CONFIG_DIR']=str(root/'config')
async def main():
    from copy import deepcopy
    from ag_ui.core import RunAgentInput
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    for answer in ['allow','deny','error']:
        calls_before = Handler.calls
        class Store:
            binding = None
            async def load(self, thread): return deepcopy(self.binding)
            async def save(self, thread, value): self.binding = deepcopy(value)
        store = Store()
        async def profile(name):
            return {'env':env,'cwd':str(root),'setting_sources':[],'tools':[],'model':'claude-sonnet-4-6','max_turns':3}
        memory = '--memory' in sys.argv
        default_options = await profile('default')
        def agent():
            if memory:
                return ClaudeAgentAdapter('probe', options=default_options, query_timeout_seconds=20)
            return ClaudeAgentAdapter('probe',session_binding_store=store,resolve_profile=profile,defer_tools=(),query_timeout_seconds=20)
        first=agent()
        initial=RunAgentInput(thread_id=answer,run_id='first',messages=[{'id':'user','role':'user','content':'Synthetic read'}],tools=[{'name':'confirm','description':'Synthetic confirmation','parameters':{'type':'object','properties':{'value':{'type':'string'}},'required':['value']}}],context=[],state=None,forwarded_props={})
        first_events=[e async for e in first.run(initial)]
        assert first_events[-1].type=='RUN_FINISHED', first_events[-1]
        assert first_events[-1].outcome.pending_tool_call_ids == ['toolu_python_original']
        assert Handler.calls-calls_before == 1, 'Deferral must not ask the model again'
        binding = first._memory_bindings[answer] if memory else store.binding
        pending=deepcopy(binding.pending)
        session=binding.session_id
        if not memory:
            await first.shutdown()
        second=first if memory else agent()
        response=RunAgentInput(thread_id=answer,run_id='second',messages=[{'id':'tool-answer','role':'tool','toolCallId':pending['id'],'content':json.dumps({'approved':answer=='allow','message':'REAL_FRONTEND_ANSWER'}), **({'error':'Frontend failed'} if answer=='error' else {})}],tools=[],context=[],state=None,forwarded_props={})
        if '--full-history' in sys.argv:
            history = [e for e in first_events if e.type == 'MESSAGES_SNAPSHOT'][-1].messages
            response.messages = [*history, *response.messages]
        second_events=[e async for e in second.run(response)]
        assert second_events[-1].type=='RUN_FINISHED',second_events[-1]
        binding = second._memory_bindings[answer] if memory else store.binding
        assert binding.session_id==session and binding.pending is None
        await second.shutdown()
        file=next((root/'config'/'projects').glob(f'*/{session}.jsonl'))
        rows=[json.loads(l) for l in file.read_text().splitlines()]
        results=[b for r in rows for b in r.get('message',{}).get('content',[]) if isinstance(b,dict) and b.get('type')=='tool_result' and b.get('tool_use_id')==pending['id']]
        assert len(results)==1,results
        restored=get_session_messages(session, directory=str(root))
        restored_results=[b for r in restored for b in r.message.get('content',[]) if isinstance(b,dict) and b.get('type')=='tool_result' and b.get('tool_use_id')==pending['id']]
        assert restored_results==results, restored_results
        emitted=[e for e in second_events if e.type=='TOOL_CALL_RESULT' and e.tool_call_id==pending['id']]
        assert len(emitted)==1,emitted
        snapshot = [e for e in second_events if e.type == 'MESSAGES_SNAPSHOT'][-1]
        snapshot_results = [m for m in snapshot.messages if m.role == 'tool' and m.tool_call_id == pending['id']]
        assert len(snapshot_results) == 1, snapshot_results
        assert snapshot_results[0].id == 'tool-answer'
        from ag_ui_claude_sdk.utils import build_agui_tool_message
        expected = build_agui_tool_message(pending['id'], results[0]['content'], bool(results[0].get('is_error')))
        assert snapshot_results[0].content == expected.content
        if results[0].get('is_error'):
            assert json.loads(emitted[0].content)=={'error':True,'content':results[0]['content']}
            assert emitted[0].raw_event['is_error'] is True
        else:
            assert 'REAL_FRONTEND_ANSWER' in str(emitted[0].content)
        assert bool(results[0].get('is_error')) == (answer == 'error'),results
        assert Handler.calls-calls_before == 2
        assert 'REAL_FRONTEND_ANSWER' in json.dumps(results[0]['content'])
        print(json.dumps({'answer':answer,'session':session,'call':pending['id'],'results':results,'calls':Handler.calls}),flush=True)

try: asyncio.run(main())
finally: server.shutdown();server.server_close()
