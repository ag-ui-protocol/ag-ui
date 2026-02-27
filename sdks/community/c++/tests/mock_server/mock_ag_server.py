#!/usr/bin/env python3
"""
AG-UI Mock Server
Local Mock server for testing C++ SDK
Supports HTTP streaming data delivery and all AG-UI protocol event types
"""

import json
import time
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import threading

class AGUIEvent:
    """AG-UI event generator"""
    
    @staticmethod
    def text_message_start(message_id="msg_001", role="assistant"):
        return {
            "type": "TEXT_MESSAGE_START",
            "message_id": message_id,
            "role": role
        }
    
    @staticmethod
    def text_message_content(message_id="msg_001", delta=""):
        return {
            "type": "TEXT_MESSAGE_CONTENT",
            "message_id": message_id,
            "delta": delta
        }
    
    @staticmethod
    def text_message_end(message_id="msg_001"):
        return {
            "type": "TEXT_MESSAGE_END",
            "message_id": message_id
        }
    
    @staticmethod
    def text_message_chunk(message_id="msg_001", content=""):
        return {
            "type": "TEXT_MESSAGE_CHUNK",
            "message_id": message_id,
            "content": content
        }
    
    @staticmethod
    def thinking_text_message_start():
        return {
            "type": "THINKING_TEXT_MESSAGE_START"
        }
    
    @staticmethod
    def thinking_text_message_content(delta=""):
        return {
            "type": "THINKING_TEXT_MESSAGE_CONTENT",
            "delta": delta
        }
    
    @staticmethod
    def thinking_text_message_end():
        return {
            "type": "THINKING_TEXT_MESSAGE_END"
        }
    
    @staticmethod
    def tool_call_start(tool_call_id="tool_001", tool_call_name="search"):
        return {
            "type": "TOOL_CALL_START",
            "toolCallId": tool_call_id,
            "toolCallName": tool_call_name
        }
    
    @staticmethod
    def tool_call_args(tool_call_id="tool_001", delta=""):
        return {
            "type": "TOOL_CALL_ARGS",
            "toolCallId": tool_call_id,
            "delta": delta
        }
    
    @staticmethod
    def tool_call_end(tool_call_id="tool_001"):
        return {
            "type": "TOOL_CALL_END",
            "toolCallId": tool_call_id
        }
    
    @staticmethod
    def tool_call_chunk(tool_call_id="tool_001", arguments="{}"):
        return {
            "type": "TOOL_CALL_CHUNK",
            "toolCallId": tool_call_id,
            "arguments": arguments
        }
    
    @staticmethod
    def tool_call_result(tool_call_id="tool_001", result=""):
        return {
            "type": "TOOL_CALL_RESULT",
            "toolCallId": tool_call_id,
            "result": result
        }
    
    @staticmethod
    def thinking_start():
        return {
            "type": "THINKING_START"
        }
    
    @staticmethod
    def thinking_end():
        return {
            "type": "THINKING_END"
        }
    
    @staticmethod
    def state_snapshot(snapshot=None):
        return {
            "type": "STATE_SNAPSHOT",
            "snapshot": snapshot or {}
        }
    
    @staticmethod
    def state_delta(delta=None):
        return {
            "type": "STATE_DELTA",
            "delta": delta or []
        }
    
    @staticmethod
    def messages_snapshot(messages=None):
        return {
            "type": "MESSAGES_SNAPSHOT",
            "messages": messages or []
        }
    
    @staticmethod
    def run_started(run_id="run_001"):
        return {
            "type": "RUN_STARTED",
            "run_id": run_id
        }
    
    @staticmethod
    def run_finished(run_id="run_001", result=None):
        return {
            "type": "RUN_FINISHED",
            "run_id": run_id,
            "result": result or {"status": "success"}
        }
    
    @staticmethod
    def run_error(error="An error occurred"):
        return {
            "type": "RUN_ERROR",
            "error": error
        }
    
    @staticmethod
    def step_started(step_id="step_001"):
        return {
            "type": "STEP_STARTED",
            "stepId": step_id
        }
    
    @staticmethod
    def step_finished(step_id="step_001"):
        return {
            "type": "STEP_FINISHED",
            "stepId": step_id
        }
    
    @staticmethod
    def raw(data=""):
        return {
            "type": "RAW",
            "data": data
        }
    
    @staticmethod
    def custom(event_type="custom_event", data=None):
        return {
            "type": "CUSTOM",
            "eventType": event_type,
            "data": data or {}
        }


class MockAGServer(BaseHTTPRequestHandler):
    """Mock AG-UI server request handler"""
    
    # Predefined test scenarios
    SCENARIOS = {
        "simple_text": [
            AGUIEvent.run_started("run_001"),
            AGUIEvent.text_message_start("msg_001", "assistant"),
            AGUIEvent.text_message_content("msg_001", "Hello, "),
            AGUIEvent.text_message_content("msg_001", "world!"),
            AGUIEvent.text_message_end("msg_001"),
            AGUIEvent.run_finished("run_001")
        ],
        "with_thinking": [
            AGUIEvent.run_started("run_002"),
            AGUIEvent.thinking_start(),
            AGUIEvent.thinking_text_message_start(),
            AGUIEvent.thinking_text_message_content("Let me think..."),
            AGUIEvent.thinking_text_message_end(),
            AGUIEvent.thinking_end(),
            AGUIEvent.text_message_start("msg_002", "assistant"),
            AGUIEvent.text_message_content("msg_002", "Based on my analysis, "),
            AGUIEvent.text_message_content("msg_002", "the answer is 42."),
            AGUIEvent.text_message_end("msg_002"),
            AGUIEvent.run_finished("run_002")
        ],
        "with_tool_call": [
            AGUIEvent.run_started("run_003"),
            AGUIEvent.text_message_start("msg_003", "assistant"),
            AGUIEvent.text_message_content("msg_003", "Let me search for that."),
            AGUIEvent.text_message_end("msg_003"),
            AGUIEvent.tool_call_start("tool_001", "web_search"),
            AGUIEvent.tool_call_args("tool_001", '{"query": "'),
            AGUIEvent.tool_call_args("tool_001", 'AG-UI protocol"}'),
            AGUIEvent.tool_call_end("tool_001"),
            AGUIEvent.tool_call_result("tool_001", "Found 10 results"),
            AGUIEvent.text_message_start("msg_004", "assistant"),
            AGUIEvent.text_message_content("msg_004", "I found some information."),
            AGUIEvent.text_message_end("msg_004"),
            AGUIEvent.run_finished("run_003")
        ],
        "with_state": [
            AGUIEvent.run_started("run_004"),
            AGUIEvent.state_snapshot({"counter": 0, "status": "started"}),
            AGUIEvent.text_message_start("msg_005", "assistant"),
            AGUIEvent.text_message_content("msg_005", "Processing..."),
            AGUIEvent.text_message_end("msg_005"),
            AGUIEvent.state_delta([
                {"op": "replace", "path": "/counter", "value": 1},
                {"op": "replace", "path": "/status", "value": "processing"}
            ]),
            AGUIEvent.text_message_start("msg_006", "assistant"),
            AGUIEvent.text_message_content("msg_006", "Done!"),
            AGUIEvent.text_message_end("msg_006"),
            AGUIEvent.state_delta([
                {"op": "replace", "path": "/counter", "value": 2},
                {"op": "replace", "path": "/status", "value": "completed"}
            ]),
            AGUIEvent.run_finished("run_004")
        ],
        "error": [
            AGUIEvent.run_started("run_005"),
            AGUIEvent.text_message_start("msg_007", "assistant"),
            AGUIEvent.text_message_content("msg_007", "Starting task..."),
            AGUIEvent.run_error("Something went wrong!")
        ],
        "all_events": [
            # Run lifecycle
            AGUIEvent.run_started("run_all"),
            
            # Steps
            AGUIEvent.step_started("step_001"),
            
            # Thinking
            AGUIEvent.thinking_start(),
            AGUIEvent.thinking_text_message_start(),
            AGUIEvent.thinking_text_message_content("Analyzing..."),
            AGUIEvent.thinking_text_message_end(),
            AGUIEvent.thinking_end(),
            
            # Text messages
            AGUIEvent.text_message_start("msg_all", "assistant"),
            AGUIEvent.text_message_content("msg_all", "Hello! "),
            AGUIEvent.text_message_content("msg_all", "This is a test."),
            AGUIEvent.text_message_end("msg_all"),
            
            # Tool calls
            AGUIEvent.tool_call_start("tool_all", "calculator"),
            AGUIEvent.tool_call_args("tool_all", '{"operation": "add", "a": 1, "b": 2}'),
            AGUIEvent.tool_call_end("tool_all"),
            AGUIEvent.tool_call_result("tool_all", "3"),
            
            # State management
            AGUIEvent.state_snapshot({"test": True}),
            AGUIEvent.state_delta([{"op": "add", "path": "/count", "value": 1}]),
            AGUIEvent.messages_snapshot([
                {"id": "msg_all", "role": "assistant", "content": "Hello! This is a test."}
            ]),
            
            # Step completion
            AGUIEvent.step_finished("step_001"),
            
            # Custom events
            AGUIEvent.custom("test_event", {"key": "value"}),
            AGUIEvent.raw("raw data"),
            
            # Run completion
            AGUIEvent.run_finished("run_all", {"status": "success", "events_count": 20})
        ]
    }
    
    def log_message(self, format, *args):
        """Custom log format"""
        print(f"[{self.log_date_time_string()}] {format % args}")
    
    def do_GET(self):
        """Handle GET requests"""
        parsed_path = urlparse(self.path)
        
        if parsed_path.path == "/health":
            self.send_health_check()
        elif parsed_path.path == "/scenarios":
            self.send_scenarios_list()
        else:
            self.send_error(404, "Not Found")
    
    def do_POST(self):
        """Handle POST requests"""
        parsed_path = urlparse(self.path)
        
        if parsed_path.path == "/api/agent/run":
            self.handle_agent_run()
        else:
            self.send_error(404, "Not Found")
    
    def send_health_check(self):
        """Health check endpoint"""
        response = {
            "status": "ok",
            "server": "AG-UI Mock Server",
            "version": "1.0.0"
        }
        self.send_json_response(response)
    
    def send_scenarios_list(self):
        """Return list of available test scenarios"""
        scenarios = {
            "scenarios": list(self.SCENARIOS.keys()),
            "description": {
                "simple_text": "Simple text message",
                "with_thinking": "With thinking process",
                "with_tool_call": "With tool call",
                "with_state": "With state management",
                "error": "Error scenario",
                "all_events": "All event types"
            }
        }
        self.send_json_response(scenarios)
    
    def handle_agent_run(self):
        """Handle agent run request"""
        # Read request body
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            request_data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return
        
        # Get scenario parameters
        scenario = request_data.get('scenario', 'simple_text')
        delay_ms = request_data.get('delay_ms', 100)  # Delay between events
        
        # Get event list
        events = self.SCENARIOS.get(scenario, self.SCENARIOS['simple_text'])
        
        # Send SSE streaming response
        self.send_sse_stream(events, delay_ms / 1000.0)
    
    def send_sse_stream(self, events, delay=0.1):
        """Send SSE streaming response"""
        # Send response headers
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')  # Changed to close, explicitly indicate connection will close
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        
        # Send event stream
        for event in events:
            # Format SSE data
            event_data = json.dumps(event, ensure_ascii=False)
            sse_message = f"data: {event_data}\n\n"
            
            try:
                self.wfile.write(sse_message.encode('utf-8'))
                self.wfile.flush()
                
                # Delay
                if delay > 0:
                    time.sleep(delay)
            except BrokenPipeError:
                # Client disconnected
                break
        
        # Critical: After sending all events, explicitly close connection
        # This allows client's curl_easy_perform to return normally
        try:
            self.wfile.flush()
            # No need to explicitly close, will auto-close after function returns
        except:
            pass
    
    def send_json_response(self, data, status=200):
        """Send JSON response"""
        response = json.dumps(data, ensure_ascii=False, indent=2)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(response.encode('utf-8'))
    
    def do_OPTIONS(self):
        """Handle CORS preflight requests"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()


def run_server(port=8080, host='0.0.0.0'):
    """Run Mock server"""
    server_address = (host, port)
    httpd = HTTPServer(server_address, MockAGServer)
    
    print("=" * 50)
    print("  AG-UI Mock Server")
    print("=" * 50)
    print(f"Server running on http://{host}:{port}")
    print(f"Health check: http://{host}:{port}/health")
    print(f"Scenarios: http://{host}:{port}/scenarios")
    print(f"Agent API: http://{host}:{port}/api/agent/run")
    print("\nAvailable scenarios:")
    for scenario in MockAGServer.SCENARIOS.keys():
        print(f"  - {scenario}")
    print("\nPress Ctrl+C to stop")
    print("=" * 50)
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n\nShutting down server...")
        httpd.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='AG-UI Mock Server')
    parser.add_argument('--port', type=int, default=8080, help='Server port (default: 8080)')
    parser.add_argument('--host', type=str, default='0.0.0.0', help='Server host (default: 0.0.0.0)')
    
    args = parser.parse_args()
    run_server(port=args.port, host=args.host)
