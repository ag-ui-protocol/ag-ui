"""No-cost real SDK root parallel native/frontend recovery control."""
import shutil
import json, os, sys, tempfile, threading, subprocess, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
base = Path(__file__).resolve().parent.parent
lang = sys.argv[1]
nested = '--nested' in sys.argv
background = '--background' in sys.argv
frontend = '--frontend' in sys.argv
mixed = '--mixed' in sys.argv
deny = '--deny' in sys.argv
followup = '--followup' in sys.argv
public_client = '--public-client' in sys.argv
cancel_frontend = '--cancel-frontend' in sys.argv
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
  if len(requests)>24:
   self.send_response(400);self.end_headers();return
  names={t['name'] for t in body.get('tools',[])}
  role='root' if 'Write' in names else ('middle' if 'Agent' in names else 'leaf')
  def tool(key,name,args): return dict(type='tool_use',id=key,name=name,input=args)
  def launch(key,kind,label): return tool(key,'Agent',dict(subagent_type=kind,description=label,prompt=label,run_in_background=background if role=='root' else False))
  results={b['tool_use_id']:b for m in body['messages'] if isinstance(m.get('content'),list) for b in m['content'] if b.get('type')=='tool_result'}
  label='leaf0' if nested else ('leaf1' if 'LEAF1' in json.dumps(body['messages']) else 'leaf0')
  if phase=='start':
   if role=='root' and 'parent0' in results: blocks=[dict(type='text',text='Background children launched')]
   elif role=='root': blocks=[launch('parent0','verifier' if nested else 'leaf','MIDDLE' if nested else 'LEAF0')] + ([] if nested else [launch('parent1','leaf','LEAF1')]) + ([tool('root-read','Read',dict(file_path=str(root/'fixture.txt')))] if mixed else [])
   elif role=='middle': blocks=[launch('inner0','leaf','LEAF0')]
   else: blocks=[tool(label,'mcp__ag_ui__chart' if frontend and label=='leaf1' else 'Read',dict(value=7) if frontend and label=='leaf1' else dict(file_path=str(root/'fixture.txt')))]
  elif role=='root':
   latest=str(body['messages'][-1].get('content',''))
   import re
   target=re.search(r'Resume child ([a-zA-Z0-9_-]+) with SendMessage',latest)
   if target:
    blocks=[tool('bridge_'+target[1]+'_'+phase,'SendMessage',dict(to=target[1],message='Continue the original task using the recorded tool results. Do not repeat completed tools.'))]
   else:
    if not background:
     for key in (['parent0'] if nested else ['parent0','parent1']):
      assert key in results and any(v in str(results[key]['content']) for v in [marker,'FRONTEND_ACTUAL','denied by user'] + (['cancelled'] if cancel_frontend else [])),results
    else:
     assert marker in json.dumps(body['messages']), 'Background completion absent'
    blocks=[dict(type='text',text='PARENT_VERIFIED')]
  else:
   key='inner0' if role=='middle' else label
   assert key in results and (any(v in str(results[key]['content']) for v in [marker,'FRONTEND_ACTUAL','denied by user'] + (['cancelled'] if cancel_frontend else []))),results
   if followup and role=='leaf' and label=='leaf0' and 'followup' not in results:
    blocks=[tool('followup','mcp__ag_ui__chart' if frontend else 'Read',dict(value=8) if frontend else dict(file_path=str(root/'fixture.txt')))]
   else:
    if followup and role=='leaf' and label=='leaf0': assert ('FRONTEND_FOLLOWUP' if frontend else marker) in str(results['followup']['content'])
    blocks=[dict(type='text',text='CHILD_COMPLETED '+str(results[key]['content']))]
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
 if public_client:
  assert mixed and frontend and not nested and not background and not followup
  from public_client_control import run_public_client
  cpk_core=sys.argv[sys.argv.index('--cpk-core')+1] if '--cpk-core' in sys.argv else None
  run_public_client(base,root,session,env,lang,lambda value:globals().__setitem__('phase',value),outputs,cpk_core,cancel_frontend,'--raw-frontend' in sys.argv)
  print(json.dumps(dict(passed=True,language=lang,publicClient=True,cpk=bool(cpk_core),evidence=str(root/'evidence.json'))))
  raise SystemExit(0)
 phases=(['start','refresh','answer1','repeat','second_restart'] if nested else ['start','refresh','answer_partial','refresh_partial','answer1','repeat','second_restart'])
 if followup: phases[phases.index('repeat'):phases.index('repeat')]=['refresh_followup','answer_followup']
 for phase in phases:
  data=dict(threadId='parallel',runId=str(uuid.uuid4()),messages=[dict(id='prompt',role='user',content='Read two files concurrently.')],tools=[dict(name='chart',description='Render chart',parameters=dict(type='object',properties=dict(value=dict(type='number'))))] if frontend else [],context=[],state={},forwardedProps={} if phase=='start' else dict(resume=session))
  if phase=='answer_partial': data['resume']=[dict(interruptId='root-read' if mixed else 'leaf0',status='resolved',payload=dict(behavior='allow'))]
  if phase in ['answer1','repeat']:
   data['resume']=[dict(interruptId=key,status='resolved',payload=dict(behavior='deny' if deny and key=='leaf1' else 'allow')) for key in (['leaf0'] if nested else ['leaf0'] if frontend else ['leaf0','leaf1'])]
   if mixed: data['resume'].append(dict(interruptId='root-read',status='resolved',payload=dict(behavior='allow')))
   if frontend: data['messages'].append(dict(id='frontend',role='tool',toolCallId='leaf1',content='FRONTEND_ACTUAL',error='denied' if deny else None))
  if phase=='answer_followup':
   if frontend: data['messages'].append(dict(id='followup-result',role='tool',toolCallId='followup',content='FRONTEND_FOLLOWUP'))
   else: data['resume']=[dict(interruptId='followup',status='resolved',payload=dict(behavior='allow'))]
  c=root/'config.json';c.write_text(json.dumps(dict(root=str(root),session=session,phase=phase,env=env,decision='allow',input=data,agents=dict(verifier=dict(description='middle',prompt='MIDDLE',tools=['Agent','Read']),leaf=dict(description='leaf',prompt='Read fixture',tools=['Read','mcp__ag_ui__chart'] if frontend else ['Read'])))))
  cmd=['node','--import',str(base/'typescript/node_modules/tsx/dist/loader.mjs'),str(base/'typescript/scripts/child-recovery-worker.mjs'),str(c)] if lang=='ts' else [sys.executable,str(base/'python/scripts/child_recovery_worker.py'),str(c)]
  process=subprocess.run(cmd,env={**env,'PYTHONPATH':str(base/'python')},capture_output=True,text=True,timeout=20)
  (root/(phase+'.log')).write_text(process.stdout+'\n'+process.stderr)
  lines=[line[7:] for line in process.stdout.splitlines() if line.startswith('EVENTS ')];assert lines,process.stderr
  events=json.loads(lines[-1]);outputs[phase]=events
  shutil.copytree(root/'config/projects', root/'snapshots'/phase/'projects', dirs_exist_ok=True)
  assert process.returncode==0,events[-1]
  if phase in ['start','refresh','answer_partial','refresh_partial']:
   ids=[i['id'] for i in events[-1]['outcome']['interrupts']]
   expected=({'leaf0'} if nested else {'leaf0','leaf1'}) | ({'root-read'} if mixed else set())
   if phase in ['answer_partial','refresh_partial']: expected.remove('root-read' if mixed else 'leaf0')
   assert set(ids)==expected,ids
  elif followup and phase in ['answer1','refresh_followup']:
   assert [i['id'] for i in events[-1]['outcome']['interrupts']]==['followup'],events[-1]
   if phase=='answer1': assert any(e['type']=='TOOL_CALL_START' and e.get('toolCallId')=='followup' for e in events),events
  else: assert events[-1]['type']=='RUN_FINISHED' and not events[-1].get('outcome'),events[-1]
 executions=(root/'executions.log').read_text().splitlines()
 assert len(executions)==(1 if nested else 1 if frontend or deny else 2)+(1 if mixed else 0)+(1 if followup and not frontend else 0),executions
 print(json.dumps(dict(passed=True,language=lang,nested=nested,background=background,evidence=str(root/'evidence.json'))))
finally:
 (root/'evidence.json').write_text(json.dumps(dict(requests=requests,events=outputs),indent=2));server.shutdown();server.server_close()
