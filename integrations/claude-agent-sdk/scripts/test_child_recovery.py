"""Real SDK subprocess test with a localhost provider. No Intelligence, database, or model credentials.
Run: python test_child_recovery.py ts|py allow|deny [--stall]
TS requires tsx installed in the integration. Python requires the integration on PYTHONPATH.
"""
import shutil
import json, os, sys, tempfile, threading, subprocess, uuid, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
base=Path(__file__).resolve().parent.parent
lang,decision=sys.argv[1:3];stall='--stall' in sys.argv
root=Path(tempfile.mkdtemp(prefix='agui-child-recovery-'))
marker='REAL_RESULT_'+uuid.uuid4().hex;(root/'fixture.txt').write_text(marker)
session=str(uuid.uuid4());requests=[];seen=set();phase='start'
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if 'count_tokens' in self.path:self.send_response(200);self.end_headers();self.wfile.write(b'{"input_tokens":10}');return
  if '/messages' not in self.path:self.send_response(404);self.end_headers();return
  parent=any(t['name']=='Agent' for t in body.get('tools',[]));requests.append({'phase':phase,'parent':parent,'body':body})
  key=(phase,parent)
  results=[b for m in body['messages'] if isinstance(m.get('content'),list) for b in m['content'] if b.get('type')=='tool_result']
  if phase=='start':
   assert key not in seen,'Parent/child continued past initial unanswered permission'
   blocks=[{'type':'tool_use','id':'original_parent' if parent else 'original_child0','name':'Agent' if parent else 'Read','input':{'subagent_type':'verifier','description':'Read fixture','prompt':'Read '+str(root/'fixture.txt'),'run_in_background':False} if parent else {'file_path':str(root/'fixture.txt')}}]
  elif phase=='answer' and parent and key not in seen:
   child=next((root/'config/projects').glob('*/'+session+'/subagents/agent-*.jsonl')).stem.removeprefix('agent-')
   blocks=[{'type':'tool_use','id':'rogue_write','name':'Write','input':{'file_path':str(root/'parent-acted.txt'),'content':'UNSAFE'}},{'type':'tool_use','id':'resume_child','name':'SendMessage','input':{'to':child,'message':'Continue the original task using the recorded tool results. Do not repeat completed tools.'}}]
  else:
   if not parent and stall:time.sleep(3);return
   result=next((b for b in results if b['tool_use_id']==('original_parent' if parent else 'original_child0')),None)
   assert result and (marker in str(result['content']) or 'denied by user' in str(result['content'])),'Provider saw no actual tool result'
   blocks=[{'type':'text','text':('PARENT_RECEIVED ' if parent else 'CHILD_RECEIVED ')+str(result['content'])}]
  seen.add(key)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  def send(t,**data):self.wfile.write(('event: '+t+'\ndata: '+json.dumps({'type':t,**data})+'\n\n').encode())
  send('message_start',message={'id':'msg_'+str(len(requests)),'type':'message','role':'assistant','model':'claude-sonnet-4-6','content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':0}})
  for i,b in enumerate(blocks):
   send('content_block_start',index=i,content_block={**b,'input':{}} if b['type']=='tool_use' else {'type':'text','text':''})
   send('content_block_delta',index=i,delta={'type':'input_json_delta','partial_json':json.dumps(b['input'])} if b['type']=='tool_use' else {'type':'text_delta','text':b['text']});send('content_block_stop',index=i)
  send('message_delta',delta={'stop_reason':'tool_use' if blocks[0]['type']=='tool_use' else 'end_turn','stop_sequence':None},usage={'output_tokens':10});send('message_stop')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
env={'PATH':os.environ['PATH'],'HOME':str(root),'CLAUDE_CONFIG_DIR':str(root/'config'),'ANTHROPIC_API_KEY':'synthetic-not-a-secret','ANTHROPIC_AUTH_TOKEN':'','ANTHROPIC_BASE_URL':f'http://127.0.0.1:{server.server_port}','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_TELEMETRY':'1'}
try:
 outputs={};snapshots=[]
 for phase in ['start','refresh1','refresh2','answer','second_restart']:
  if stall and phase=='second_restart':break
  config=root/'config.json';config.write_text(json.dumps(dict(root=str(root),session=session,phase=phase,env=env,decision=decision)))
  cmd=['node','--import',str(base/'typescript/node_modules/tsx/dist/loader.mjs'),str(base/'typescript/scripts/child-recovery-worker.mjs'),str(config)] if lang=='ts' else [sys.executable,str(base/'python/scripts/child_recovery_worker.py'),str(config)]
  completed=subprocess.run(cmd,env={**env,'PYTHONPATH':str(base/'python')},capture_output=True,text=True,timeout=20)
  (root/(phase+'.log')).write_text(completed.stdout+'\n'+completed.stderr)
  lines=[line[7:] for line in completed.stdout.splitlines() if line.startswith('EVENTS ')];assert lines,completed.stderr+completed.stdout
  events=json.loads(lines[-1]);outputs[phase]=events
  shutil.copytree(root/'config/projects', root/'snapshots'/phase/'projects', dirs_exist_ok=True)
  if stall and phase=='answer':assert any(e['type']=='RUN_ERROR' for e in events);continue
  assert completed.returncode==0,completed.stderr+completed.stdout
  if phase in ['start','refresh1','refresh2']:
   terminal=events[-1];assert terminal['type']=='RUN_FINISHED' and terminal['outcome']['type']=='interrupt',events
   snapshots.append(terminal['outcome']);assert snapshots[-1]==snapshots[0]
   assert not (root/'executions.log').exists()
   assert len(requests)==2,'Refreshing unanswered child invoked model'
  else:
   assert events[-1]['type']=='RUN_FINISHED'
   if phase=='answer':
    results={e['toolCallId']:e for e in events if e['type']=='TOOL_CALL_RESULT'}
    assert {'original_child0','original_parent'} <= results.keys(),results
    assert (marker if decision=='allow' else 'denied by user') in str(results['original_child0']['content'])
    assert (marker if decision=='allow' else 'denied by user') in str(results['original_parent']['content'])
 assert not (root/'parent-acted.txt').exists(),'Parent acted during recovery'
 assert len((root/'executions.log').read_text().splitlines())==(1 if decision=='allow' else 0) if (root/'executions.log').exists() else decision=='deny'
 assert len(requests)==(4 if stall else 6),len(requests)
 (root/'evidence.json').write_text(json.dumps(dict(requests=requests,events=outputs),indent=2))
 print(json.dumps(dict(language=lang,decision=decision,stalled=stall,passed=True,requests=len(requests),evidence=str(root/'evidence.json'))))
finally:server.shutdown();server.server_close()
