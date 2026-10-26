"""Opt-in native child recovery; no event database dependency.

The transport shim is deliberately pinned to the verified SDK/CLI release.
"""
import asyncio
import copy
import json
import os
import shlex
import signal
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable
from claude_agent_sdk import ClaudeSDKClient, HookMatcher, ResultMessage, SystemMessage, UserMessage, ToolResultBlock
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport
from .native_history import NativeHistory

MESSAGE = 'Continue the original task using the recorded tool results. Do not repeat completed tools.'


@dataclass
class NativeChildRecoveryConfig:
    directory: str
    tools: list[str]
    execute: Callable[[dict, str], Awaitable[dict]]
    acquire: Callable[[str], Awaitable[Callable[[], Awaitable[None]]]]
    timeout_seconds: float = 10


class IsolatedTransport(SubprocessCLITransport):
    """Own a process group, and kill it before SDK EOF/close can unblock hooks."""
    def __init__(self, options):
        async def empty():
            if False:
                yield {}
        super().__init__(empty(), options)
        self._kill_sent = False
        self.finished_normally = False
        self._wrapper = tempfile.TemporaryDirectory(prefix='agui-claude-worker-')
        path = Path(self._wrapper.name) / 'claude'
        code = 'import os,sys;os.setsid();os.execv(sys.argv[1],sys.argv[1:])'
        path.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' -c ' + shlex.quote(code) + ' ' + shlex.quote(self._cli_path or self._find_cli()) + ' "$@"\n')
        path.chmod(0o700)
        self._cli_path = str(path)

    def kill_now(self):
        if self._process and self._process.returncode is None and not self._kill_sent:
            try:
                os.killpg(self._process.pid, signal.SIGKILL)
                self._kill_sent = True
            except ProcessLookupError:
                self._process.kill()
                self._kill_sent = True

    async def close(self):
        if not self.finished_normally:
            self.kill_now()
        if self._process and not self.finished_normally:
            await self._process.wait()
        try:
            await super().close()
        finally:
            self._wrapper.cleanup()


class NativeChildRecovery:
    def __init__(self, config):
        if not config.tools or not 0 < config.timeout_seconds < 50:
            raise ValueError('Native child recovery requires tools and a deadline below 50 seconds')
        self.config = config
        self.outcome = None
        self.session_id = None
        self.transport = None
        self.stopped = False
        self.pausing = False
        self.bridge = False
        self.completed = False
        self.gate_held = False
        self.resume_issued = False
        self.failure = None
        self.bridge_results = {}

    def stop(self):
        self.stopped = True
        if self.transport:
            self.transport.kill_now()

    def history(self):
        return NativeHistory(self.config.directory, self.session_id, self.config.tools)

    def interrupt(self, checkpoint):
        self.outcome = {'type': 'interrupt', 'interrupts': [dict(id=c['id'], toolCallId=c['id'], reason='tool_approval',
                         metadata=dict(source='claude-sdk-native-child', sessionId=self.session_id, childId=checkpoint['childId'], parentToolUseId=checkpoint['parent']['id'],toolName=c['name'], input=c['input'])) for c in checkpoint['pending']]}

    async def run(self, input_data, options, prompt):
        if os.name != 'posix' or options.session_store or options.fork_session or options.resume_session_at or options.continue_conversation:
            raise ValueError('Native child recovery requires exclusive local POSIX sessions without custom store, fork or rewind')
        self.session_id = options.resume or options.session_id
        if not self.session_id:
            raise ValueError('Native child recovery requires an explicit session_id for new sessions')
        release = await self.config.acquire(self.session_id)
        try:
            checkpoint = self.history().inspect() if options.resume else None
            if checkpoint:
                responses = input_data.resume or []
                ids = [r.interrupt_id for r in responses]
                if len(set(ids)) != len(ids) or any(key not in {c['id'] for c in checkpoint['calls']} for key in ids):
                    raise ValueError('Answer does not match the original child call or is duplicated')
                for response in responses:
                    if response.status != 'cancelled' and (response.payload or {}).get('behavior') not in ('allow', 'deny'):
                        raise ValueError('Child answer requires behavior allow or deny')
                    if (response.payload or {}).get('updatedInput'):
                        raise ValueError('Native recovery answers cannot change the original tool input')
                results = {}
                for response in responses:
                    call = next((c for c in checkpoint['pending'] if c['id'] == response.interrupt_id), None)
                    if not call:
                        continue
                    allow = response.status != 'cancelled' and response.payload['behavior'] == 'allow'
                    result = await self.config.execute(copy.deepcopy(call), f"{self.session_id}:{checkpoint['childId']}:{call['id']}") if allow else dict(content='Tool execution denied by user', is_error=True)
                    if not isinstance(result.get('content'), str) or ('is_error' in result and not isinstance(result['is_error'], bool)):
                        raise ValueError('Recovery executor must return actual string content and optional is_error')
                    results[call['id']] = result
                if results:
                    self.history().answer(checkpoint, results)
                    yield UserMessage(content=[ToolResultBlock(tool_use_id=key, content=r['content'], is_error=bool(r.get('is_error'))) for key, r in results.items()], parent_tool_use_id=checkpoint['parent']['id'])
                checkpoint = self.history().inspect()
                if checkpoint['pending']:
                    self.interrupt(checkpoint)
                    return
                if checkpoint['final'] is None:
                    self.bridge = True
                    async for _ in self.execute(options, f"Resume child {checkpoint['childId']} with SendMessage, message exactly: {MESSAGE}", checkpoint):
                        pass
                    self.history().settle_bridge(checkpoint, self.bridge_results)
                    if self.pausing:
                        next_checkpoint = self.history().inspect()
                        if next_checkpoint and next_checkpoint['pending']:
                            self.interrupt(next_checkpoint)
                            return
                    if not self.completed or not self.gate_held:
                        raise self.failure or RuntimeError('Child recovery did not complete while the parent was held')
                    self.bridge = False
                completed = self.history().inspect()
                self.history().repair(checkpoint)
                yield UserMessage(content=[ToolResultBlock(tool_use_id=checkpoint['parent']['id'], content=completed['final'], is_error=False)])
                prompt = 'Continue from the completed child result recorded in your history.'
            elif input_data.resume:
                raise ValueError('No unanswered native child call matches this answer')
            async for message in self.execute(options, prompt):
                yield message
            if self.pausing:
                checkpoint = self.history().inspect()
                if not checkpoint or not checkpoint['pending']:
                    raise RuntimeError('Child approval was not durably recorded')
                self.interrupt(checkpoint)
        finally:
            self.stop()
            await release()

    async def execute(self, options, prompt, checkpoint=None):
        self.stopped = False
        opts = copy.copy(options)
        opts.session_id = None if options.resume else options.session_id
        opts.extra_args = {**(options.extra_args or {}), 'await-initialize': None}

        async def pre(data, tool_id, context):
            if data['tool_name'] == 'Agent' and (data.get('agent_id') or data.get('tool_input', {}).get('run_in_background') is not False):
                return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Native recovery requires one direct foreground child. Set run_in_background to false.'}}
            if self.bridge and not data.get('agent_id'):
                args = data.get('tool_input', {})
                if not self.resume_issued and data['tool_name'] == 'SendMessage' and args.get('to') == checkpoint['childId'] and args.get('message') == MESSAGE:
                    self.resume_issued = True
                    return {}
                self.bridge_results[data['tool_use_id']] = dict(content='Parent tool was not executed: held during child recovery', is_error=True)
                return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Parent is held during child recovery'}}
            if data.get('agent_id') and data['tool_name'] in self.config.tools:
                self.pausing = True
                deadline = asyncio.get_running_loop().time() + 4
                while True:
                    try:
                        saved = self.history().inspect()
                        if saved and any(c['id'] == data['tool_use_id'] for c in saved['pending']):
                            break
                    except (ValueError, FileNotFoundError) as error:
                        if asyncio.get_running_loop().time() >= deadline:
                            self.failure = error
                            break
                    if asyncio.get_running_loop().time() >= deadline:
                        self.failure = RuntimeError('Native approval was not flushed before recovery deadline')
                        break
                    await asyncio.sleep(.025)
                self.stop()
                await asyncio.Event().wait()
            return {}

        async def post(data, tool_id, context):
            if self.bridge and not data.get('agent_id') and data['tool_name'] == 'SendMessage':
                self.bridge_results[data['tool_use_id']] = dict(content=json.dumps(data['tool_response']), is_error=False)
                self.gate_held = True
                if self.completed:
                    self.stop()
                await asyncio.Event().wait()
            return {}

        opts.hooks = {**(options.hooks or {}), 'PreToolUse': [*(options.hooks or {}).get('PreToolUse', []), HookMatcher(hooks=[pre], timeout=60)],
                      'PostToolUse': [*(options.hooks or {}).get('PostToolUse', []), HookMatcher(hooks=[post], timeout=60)]}
        self.transport = IsolatedTransport(opts)
        def timeout():
            self.failure = RuntimeError('Child recovery timed out; parent remains unresolved')
            self.stop()
        timer = asyncio.get_running_loop().call_later(self.config.timeout_seconds, timeout) if self.bridge else None
        expected_stop = False
        try:
            async with ClaudeSDKClient(options=opts, transport=self.transport) as client:
                await client.query(prompt, session_id=self.session_id)
                try:
                    async for message in client.receive_messages():
                        if self.bridge and isinstance(message, SystemMessage) and message.subtype == 'task_notification' and message.data.get('task_id') == checkpoint['childId'] and message.data.get('status') == 'completed':
                            while not self.stopped and not self.history().completed(checkpoint):
                                await asyncio.sleep(.025)
                            self.completed = not self.stopped
                            if self.gate_held:
                                self.stop()
                        if isinstance(message, SystemMessage) and message.subtype == 'init' and message.data.get('claude_code_version') != '2.1.306':
                            raise RuntimeError('Native child recovery requires CLI 2.1.306')
                        if not self.bridge:
                            yield message
                        if not self.bridge and isinstance(message, ResultMessage):
                            self.transport.finished_normally = True
                            break
                finally:
                    expected_stop = self.stopped
                    if not self.transport.finished_normally:
                        self.stop()
        except Exception:
            if not expected_stop:
                raise
        finally:
            self.stop()
            if timer:
                timer.cancel()
        if self.failure:
            raise self.failure
