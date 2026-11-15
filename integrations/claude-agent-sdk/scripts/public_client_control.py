"""Actual public-client HTTP transport in front of fresh real-SDK adapter workers."""
import json,os,subprocess,sys,threading,shutil
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer

def run_public_client(base,root,session,env,lang,set_phase,outputs,cpk_core=None,cancel=False,raw=False):
    tools=[dict(name='chart',description='Actual chart catalog',parameters=dict(type='object',properties=dict(value=dict(type='number')),required=['value']))]
    tools += [dict(name=name,description='Runtime catalog '+name,parameters=dict(type='object',properties={})) for name in ['pieChart','barChart','render_a2ui','read_me','create_view']]
    context=[dict(description='client context',value='PUBLIC_CLIENT_CONTEXT')]
    initial=dict(threadId=session,runId='start',messages=[dict(id='prompt',role='user',content='Read two files concurrently.')],tools=tools,context=context,state={},forwardedProps={})
    received=[]
    def worker(data,phase):
        set_phase(phase)
        cfg=dict(root=str(root),session=session,phase=phase,env=env,input=data,agents=dict(verifier=dict(description='middle',prompt='MIDDLE',tools=['Agent','Read']),leaf=dict(description='leaf',prompt='Read fixture',tools=['Read','mcp__ag_ui__chart'])))
        path=root/(phase+'-input.json');path.write_text(json.dumps(cfg))
        cmd=['node','--import',str(base/'typescript/node_modules/tsx/dist/loader.mjs'),str(base/'typescript/scripts/child-recovery-worker.mjs'),str(path)] if lang=='ts' else [sys.executable,str(base/'python/scripts/child_recovery_worker.py'),str(path)]
        result=subprocess.run(cmd,env={**env,'PYTHONPATH':str(base/'python')},capture_output=True,text=True,timeout=25)
        (root/(phase+'.log')).write_text(result.stdout+'\n'+result.stderr)
        lines=[line[7:] for line in result.stdout.splitlines() if line.startswith('EVENTS ')];assert lines,result.stderr
        events=json.loads(lines[-1]);outputs[phase]=events
        shutil.copytree(root/'config/projects',root/'snapshots'/phase/'projects',dirs_exist_ok=True)
        assert result.returncode==0,events[-1]
        return events
    worker(initial,'start')
    # Import only canonical root messages. Child calls remain in child native histories.
    root_file=next((root/'config/projects').glob('*/*.jsonl'))
    imported=[]
    for row in map(json.loads,root_file.read_text().splitlines()):
        if row.get('type') not in ('assistant','user'):continue
        content=row.get('message',{}).get('content',[])
        if isinstance(content,str):imported.append(dict(id=row['uuid'],role=row['type'],content=content));continue
        text='\n'.join(b['text'] for b in content if b.get('type')=='text')
        calls=[dict(id=b['id'],type='function',function=dict(name=b['name'],arguments=json.dumps(b['input']))) for b in content if b.get('type')=='tool_use']
        if text or calls:imported.append(dict(id=row.get('message',{}).get('id') or row['uuid'],role=row['type'],content=text,**(dict(toolCalls=calls) if calls else {})))
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            try:
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert {t['name'] for t in data['tools']}=={t['name'] for t in tools},data['tools']
                assert any(c['value']=='PUBLIC_CLIENT_CONTEXT' for c in data['context']),data['context']
                received.append(data)
                events=worker(data,['refresh','answer1','repeat','second_restart'][len(received)-1])
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                for event in events:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
            except Exception as error:
                self.send_response(500);self.end_headers();self.wfile.write(str(error).encode())
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        cfg=root/'client.json';cfg.write_text(json.dumps(dict(url=f'http://127.0.0.1:{server.server_port}/run',session=session,messages=imported,tools=tools,context=context,cpkCore=cpk_core,cancel=cancel,raw=raw,output=str(root/'public-client.json'))))
        result=subprocess.run(['node',str(base/'typescript/scripts/public-client-driver.mjs'),str(cfg)],capture_output=True,text=True,timeout=100)
        (root/'public-client.log').write_text(result.stdout+'\n'+result.stderr)
        assert result.returncode==0,result.stdout+'\n'+result.stderr
        assert len(received)==4,'Partial client submission must never reach the backend'
        assert len((root/'executions.log').read_text().splitlines())==2,'Native Read must execute once per original root/child ID'
        return json.loads((root/'public-client.json').read_text())
    finally:
        (root/'http-inputs.json').write_text(json.dumps(received,indent=2));server.shutdown();server.server_close()


def run_registered_root_client(base, root, session, env, lang, set_phase, outputs, cpk_core):
    """Real registered handlers return empty strings; public full resume reuses them."""
    received = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            try:
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert [t['name'] for t in data['tools']] == ['chart']
                assert any(c['value']=='REGISTERED_ROOT_CONTEXT' for c in data['context'])
                received.append(data)
                phase = ['start','answer2','repeat','second_restart'][len(received)-1]
                set_phase(phase)
                cfg = dict(root=str(root),session=session,phase=phase,env=env,input=data)
                path = root/(phase+'-input.json');path.write_text(json.dumps(cfg))
                cmd = ['node','--import',str(base/'typescript/node_modules/tsx/dist/loader.mjs'),str(base/'typescript/scripts/child-recovery-worker.mjs'),str(path)] if lang=='ts' else [sys.executable,str(base/'python/scripts/child_recovery_worker.py'),str(path)]
                result = subprocess.run(cmd,env={**env,'PYTHONPATH':str(base/'python')},capture_output=True,text=True,timeout=25)
                (root/(phase+'.log')).write_text(result.stdout+'\n'+result.stderr)
                lines=[line[7:] for line in result.stdout.splitlines() if line.startswith('EVENTS ')];assert lines,result.stderr
                events=json.loads(lines[-1]);outputs[phase]=events
                shutil.copytree(root/'config/projects',root/'snapshots'/phase/'projects',dirs_exist_ok=True)
                assert result.returncode==0,events[-1]
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                for event in events:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
            except Exception as error:
                self.send_response(500);self.end_headers();self.wfile.write(str(error).encode())
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        cfg=root/'registered-client.json';cfg.write_text(json.dumps(dict(url=f'http://127.0.0.1:{server.server_port}/run',session=session,cpkCore=cpk_core,output=str(root/'registered-client.json.out'))))
        result=subprocess.run(['node',str(base/'typescript/scripts/registered-root-driver.mjs'),str(cfg)],capture_output=True,text=True,timeout=100)
        (root/'registered-client.log').write_text(result.stdout+'\n'+result.stderr)
        assert result.returncode==0,result.stdout+'\n'+result.stderr
        assert len(received)==4
        assert not (root/'executions.log').exists(),'Frontend calls must never use native executor'
    finally:
        (root/'http-inputs.json').write_text(json.dumps(received,indent=2));server.shutdown();server.server_close()
