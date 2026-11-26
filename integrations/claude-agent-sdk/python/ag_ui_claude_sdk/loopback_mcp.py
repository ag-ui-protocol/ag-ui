"""Authenticated per-query loopback MCP transport, ready before native replay."""
import asyncio
import secrets
import socket
from contextlib import contextmanager

import uvicorn
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager


class _Server(uvicorn.Server):
    # This server is embedded in an application which owns its signal handlers.
    def install_signal_handlers(self):
        pass

    @contextmanager
    def capture_signals(self):
        yield


class LoopbackMcpServer:
    def __init__(self, sdk_server):
        self._manager = StreamableHTTPSessionManager(sdk_server['instance'], json_response=True)
        self._secret = 'Bearer ' + secrets.token_hex(32)
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.bind(('127.0.0.1', 0))
        self._socket.setblocking(False)
        self._host = f'127.0.0.1:{self._socket.getsockname()[1]}'
        self._server = _Server(uvicorn.Config(self._app, lifespan='off', interface='asgi3', proxy_headers=False, log_level='error', access_log=False, timeout_graceful_shutdown=2))
        self._task = None

    async def _app(self, scope, receive, send):
        headers = dict(scope.get('headers', []))
        authorized = secrets.compare_digest(headers.get(b'authorization', b''), self._secret.encode())
        if scope.get('path') != '/mcp' or headers.get(b'host') != self._host.encode() or not authorized:
            await send({'type': 'http.response.start', 'status': 403, 'headers': []})
            await send({'type': 'http.response.body', 'body': b''})
            return
        await self._manager.handle_request(scope, receive, send)

    async def _serve(self):
        # Both entry and exit of the MCP task group belong to this task.
        async with self._manager.run():
            await self._server.serve(sockets=[self._socket])

    async def start(self):
        self._task = asyncio.create_task(self._serve(), name='claude-sdk-loopback-mcp')
        try:
            async with asyncio.timeout(5):
                while not self._server.started:
                    if self._task.done():
                        await self._task
                        raise RuntimeError('SDK tool endpoint stopped during startup')
                    await asyncio.sleep(0.01)
        except BaseException:
            await self.close()
            raise
        # CLI-supported MCP configuration is passed through verbatim by the
        # Python SDK. alwaysLoad ensures connection before deferred-tool replay.
        return {'type': 'http', 'url': f'http://{self._host}/mcp',
                'headers': {'Authorization': self._secret}, 'alwaysLoad': True}

    async def close(self):
        self._server.should_exit = True
        try:
            if self._task is not None:
                try:
                    await asyncio.wait_for(self._task, timeout=5)
                except asyncio.TimeoutError:
                    self._task.cancel()
                    await asyncio.gather(self._task, return_exceptions=True)
        finally:
            self._socket.close()
