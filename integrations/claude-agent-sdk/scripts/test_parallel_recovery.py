"""No-cost real SDK root parallel native/frontend recovery control."""
import shutil
import json, os, sys, tempfile, threading, subprocess, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
base = Path(__file__).resolve().parent.parent
lang = sys.argv[1]
registered_root = '--registered-root' in sys.argv
frontend = '--frontend' in sys.argv or registered_root
deny = '--deny' in sys.argv
state_control = '--state' in sys.argv
root = Path(tempfile.mkdtemp(prefix='agui-parallel-'))
marker = 'ACTUAL_' + uuid.uuid4().hex
(root/'fixture.txt').write_text(marker)
session = str(uuid.uuid4()); requests=[]; phase='start'
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if 'count_tokens' in self.path: self.send_response(200);self.end_headers();self.wfile.write(b'{"input_tokens":10}');return
  requests.append(dict(phase=phase,body=body))
  if phase=='start':
   blocks=[dict(type='tool_use',id='parallel'+str(i),name='mcp__ag_ui__chart' if frontend and (i==1 or registered_root) else 'Read',input=dict(value=7) if frontend and (i==1 or registered_root) else dict(file_path=str(root/'fixture.txt'))) for i in range(2)] + ([dict(type='tool_use',id='state-update',name='mcp__ag_ui__ag_ui_update_state',input=dict(state_updates=dict(counter=2)))] if state_control else [])
  else:
   results=[b for m in body['messages'] if isinstance(m.get('content'),list) for b in m['content'] if b.get('type')=='tool_result']
   for i in range(2):
    result=next((r for r in results if r['tool_use_id']=='parallel'+str(i)),None)
    expected = 'FRONTEND_ACTUAL' if frontend and (i==1 or registered_root) else ('denied by user' if deny and i==1 else marker)
    assert result and (result['content']=='' if registered_root else expected in str(result['content'])), (i,results)
   blocks=[dict(type='text',text='Verified original results')]
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  def send(t,**data): self.wfile.write(('event: '+t+'\ndata: '+json.dumps(dict(type=t,**data))+'\n\n').encode())
  send('message_start',message=dict(id='msg_'+str(len(requests)),type='message',role='assistant',model='claude-sonnet-4-6',content=[],stop_reason=None,stop_sequence=None,usage=dict(input_tokens=10,output_tokens=0)))
  for i,b in enumerate(blocks):
   send('content_block_start',index=i,content_block={**b,'input':{}} if b['type']=='tool_use' else dict(type='text',text=''))
   send('content_block_delta',index=i,delta=dict(type='input_json_delta',partial_json=json.dumps(b['input'])) if b['type']=='tool_use' else dict(type='text_delta',text=b['text']))
   send('content_block_stop',index=i)
  send('message_delta',delta=dict(stop_reason='tool_use' if blocks[0]['type']=='tool_use' else 'end_turn',stop_sequence=None),usage=dict(output_tokens=10));send('message_stop')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(PATH=os.environ['PATH'],HOME=str(root),CLAUDE_CONFIG_DIR=str(root/'config'),ANTHROPIC_API_KEY='synthetic-not-a-secret',ANTHROPIC_AUTH_TOKEN='',ANTHROPIC_BASE_URL=f'http://127.0.0.1:{server.server_port}',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_TELEMETRY='1')
outputs={}
try:
 if registered_root:
  from public_client_control import run_registered_root_client
  cpk_core=sys.argv[sys.argv.index('--cpk-core')+1]
  run_registered_root_client(base,root,session,env,lang,lambda value:globals().__setitem__('phase',value),outputs,cpk_core)
  print(json.dumps(dict(passed=True,language=lang,registeredRoot=True,evidence=str(root/'evidence.json'))))
  raise SystemExit(0)
 for phase in ['start','refresh','answer1','refresh_partial','answer2','repeat','second_restart']:
  data=dict(threadId='parallel',runId=str(uuid.uuid4()),messages=[dict(id='prompt',role='user',content='Read two files concurrently.')],tools=[dict(name='chart',description='Render chart',parameters=dict(type='object',properties=dict(value=dict(type='number'))))] if frontend else [],context=[],state=dict(counter=1 if phase=='start' else 2) if state_control else {},forwardedProps={} if phase=='start' else dict(resume=session))
  if phase=='answer1': data['resume']=[dict(interruptId='parallel0',status='resolved',payload=dict(behavior='allow'))]
  if phase in ['answer2','repeat']:
   if frontend: data['messages'].append(dict(id='frontend-result',role='tool',toolCallId='parallel1',content='FRONTEND_ACTUAL'))
   else: data['resume']=[dict(interruptId='parallel1',status='resolved',payload=dict(behavior='deny' if deny else 'allow'))]
  if phase=='repeat' and '--history' in sys.argv:
   data.pop('resume',None)
   data['messages']=next(e['messages'] for e in reversed(outputs['answer2']) if e['type']=='MESSAGES_SNAPSHOT')
  c=root/'config.json';c.write_text(json.dumps(dict(root=str(root),session=session,phase=phase,env=env,decision='allow',input=data)))
  cmd=['node','--import',str(base/'typescript/node_modules/tsx/dist/loader.mjs'),str(base/'typescript/scripts/child-recovery-worker.mjs'),str(c)] if lang=='ts' else [sys.executable,str(base/'python/scripts/child_recovery_worker.py'),str(c)]
  process=subprocess.run(cmd,env={**env,'PYTHONPATH':str(base/'python')},capture_output=True,text=True,timeout=20)
  (root/(phase+'.log')).write_text(process.stdout+'\n'+process.stderr)
  lines=[line[7:] for line in process.stdout.splitlines() if line.startswith('EVENTS ')];assert lines,process.stderr
  events=json.loads(lines[-1]);outputs[phase]=events
  shutil.copytree(root/'config/projects', root/'snapshots'/phase/'projects', dirs_exist_ok=True)
  assert process.returncode==0,events[-1]
  if phase in ['start','refresh','answer1','refresh_partial']:
   ids=[i['id'] for i in events[-1]['outcome']['interrupts']]
   assert set(ids)==({'parallel0','parallel1'} if phase in ['start','refresh'] else {'parallel1'}),ids
   assert len(requests)==1,requests
  else: assert events[-1]['type']=='RUN_FINISHED'
  if state_control and phase=='start':
   assert any(e['type']=='STATE_SNAPSHOT' and e.get('snapshot',{}).get('counter')==2 for e in events), 'State update did not reach AG-UI'
 executions=(root/'executions.log').read_text().splitlines()
 assert len(executions)==(1 if frontend or deny else 2),executions
 assert len(requests)==4,len(requests)
 print(json.dumps(dict(passed=True,language=lang,frontend=frontend,deny=deny,evidence=str(root/'evidence.json'))))
finally:
 (root/'evidence.json').write_text(json.dumps(dict(requests=requests,events=outputs),indent=2));server.shutdown();server.server_close()
