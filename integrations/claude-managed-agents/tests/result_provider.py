"""Local HTTP replay of saved native child results; never contacts a provider."""
import json
import sys
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

row = json.loads(Path(os.environ.get('AGUI_RESULT_FIXTURE', Path(__file__).parents[1] / 'fixtures/child-results.json')).read_text())[sys.argv[1]]
completed = len(sys.argv) > 2
idle = {'type': 'session.status_idle', 'id': 'local-idle', 'stop_reason': {'type': 'end_turn'}}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path.endswith('/events/stream'):
            events = [*row['root'][1:], idle] if not completed else [idle]
            data = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif '/threads/' in path and path.endswith('/events'):
            self.reply({'data': row['native'], 'has_more': False})
        elif path.endswith('/events'):
            self.reply({'data': [*row['root'], idle] if completed else row['root'][:1], 'has_more': False})
        else:
            self.reply({'id': 'native', 'status': 'idle', 'tools': []})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}')
        events = body.get('events', [])
        confirmations = [e for e in events if e['type'] == 'user.tool_confirmation']
        for e in confirmations:
            assert e['tool_use_id'] == row['root'][0]['id']
            assert e['result'] == row['root'][1]['result']
        self.reply({'id': 'native', 'data': [dict(e, id='posted-' + str(i)) for i, e in enumerate(events)]})

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
