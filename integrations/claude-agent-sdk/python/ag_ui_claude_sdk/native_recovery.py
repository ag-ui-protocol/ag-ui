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
from .utils import build_agui_tool_message

MESSAGE = 'Continue the original task using the recorded tool results. Do not repeat completed tools.'


def same_json(left, right):
    """JSON equality without Python's True == 1 coercion."""
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(same_json(left[k], right[k]) for k in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(same_json(a, b) for a, b in zip(left, right))
    return left == right


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
    def __init__(self, config, automatic=None):
        if not 0 < config.timeout_seconds < 50:
            raise ValueError('Native child recovery requires tools and a deadline below 50 seconds')
        self.config = config
        self.automatic = automatic or {}
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
        self.outcome = {'type': 'interrupt', 'interrupts': [dict(id=c['id'], toolCallId=c['id'], reason='tool_call' if c['name'] in self.frontend_names else 'tool_approval',
                         metadata=dict(source='claude-sdk-native-child', sessionId=self.session_id, childId=checkpoint['childId'], parentToolUseId=checkpoint['parent']['id'],toolName=c['name'], input=c['input'])) for c in checkpoint['pending']]}

    def interrupt_pending(self, checkpoints):
        interrupts = []
        for checkpoint in checkpoints:
            self.interrupt(checkpoint)
            interrupts.extend(self.outcome['interrupts'])
        self.outcome = dict(type='interrupt', interrupts=interrupts) if interrupts else None
        return bool(interrupts)

    async def answer_automatic(self, checkpoints):
        for cp in checkpoints:
            for call in cp['pending']:
                handler = self.automatic.get(call['name'])
                if handler is None:
                    continue
                result = await handler(call)
                self.history().answer(cp, {call['id']: result})
                yield UserMessage(content=[ToolResultBlock(tool_use_id=call['id'], content=result['content'], is_error=bool(result.get('is_error')))], parent_tool_use_id=cp['parent']['id'] or None)

    async def answer_checkpoint(self, input_data, checkpoint, validate_only=False):
        results = {}
        for call in checkpoint['calls']:
            decisions = [r for r in (input_data.resume or []) if r.interrupt_id == call['id']]
            messages = [m for m in input_data.messages if m.role == 'tool' and m.tool_call_id == call['id']]
            if len(decisions) > 1 or len(messages) > 1:
                raise ValueError('Duplicate or conflicting tool answers')
            response = decisions[0] if decisions else None
            message = messages[0] if messages else None
            saved = self.history().result(checkpoint, call['id'])
            # A sibling may have failed after this result was saved but before
            # AG-UI received it. Replay from native history, without execution.
            if response is None and message is None and not (saved is not None and call['name'] in self.config.tools):
                continue
            frontend = call['name'] in self.frontend_names
            if response is not None and message is not None and not frontend and saved is None:
                raise ValueError('Duplicate or conflicting tool answers')
            submitted = None
            if message is not None:
                if saved is None and call['name'] not in self.frontend_names:
                    raise ValueError('Client tool results may only answer configured frontend tools')
                marker = (message.metadata or {}).get('ag-ui:tool-result', {})
                error = message.error or (marker.get('error') if isinstance(marker, dict) else None)
                submitted = dict(content=message.content if isinstance(message.content, str) else json.dumps(message.content), is_error=bool(error))
            if response is not None:
                if call['name'] in self.automatic:
                    raise ValueError('Internal state acknowledgements do not accept approval answers')
                if frontend:
                    if submitted is None:
                        raise ValueError('Frontend resume requires its actual tool result')
                    expected = {'status': 'cancelled'} if response.status == 'cancelled' else response.payload if response.payload is not None else {'status': 'resolved'}
                    # Registered handlers return raw strings, including "";
                    # useInterrupt emits JSON. Preserve the actual message bytes.
                    actual_content = saved['content'] if saved is not None else submitted['content']
                    matches = isinstance(expected, str) and actual_content == expected
                    if not matches:
                        try:
                            matches = same_json(json.loads(actual_content), expected)
                        except (TypeError, ValueError):
                            pass  # Non-JSON strings require an exact raw match.
                    if not matches:
                        raise ValueError('Frontend resume payload conflicts with its tool result')
                    if response.status == 'cancelled':
                        submitted['is_error'] = True
                else:
                    if response.status != 'cancelled' and (not isinstance(response.payload, dict) or response.payload.get('behavior') not in ('allow', 'deny')):
                        raise ValueError('Child answer requires behavior allow or deny')
                    if isinstance(response.payload, dict) and response.payload.get('updatedInput'):
                        raise ValueError('Native recovery answers cannot change the original tool input')
            if saved is not None:
                if submitted is not None and (submitted['content'] != saved['content'] or submitted['is_error'] != saved['is_error']) and not (submitted['is_error'] == saved['is_error'] and message.content == build_agui_tool_message(call['id'], saved['rawContent'], saved['is_error']).content):
                    raise ValueError('Retransmitted frontend result differs from canonical history')
                if not validate_only and message is None and call['name'] in self.config.tools:
                    yield UserMessage(content=[ToolResultBlock(tool_use_id=call['id'], content=saved['rawContent'], is_error=saved['is_error'])], parent_tool_use_id=checkpoint['parent']['id'] or None)
                continue
            if not any(c['id'] == call['id'] for c in checkpoint['pending']):
                raise ValueError('Tool is not awaiting an answer')
            if validate_only:
                continue
            result = submitted
            if result is None:
                result = await self.config.execute(copy.deepcopy(call), f"{self.session_id}:{checkpoint['childId']}:{call['id']}") if response.status != 'cancelled' and response.payload.get('behavior') == 'allow' else dict(content='Tool execution denied by user', is_error=True)
            if not isinstance(result.get('content'), str) or ('is_error' in result and not isinstance(result['is_error'], bool)):
                raise ValueError('Recovery executor must return actual string content and optional is_error')
            self.history().answer(checkpoint, {call['id']: result})
            results[call['id']] = result
        if results:
            yield UserMessage(content=[ToolResultBlock(tool_use_id=key, content=r['content'], is_error=bool(r.get('is_error'))) for key,r in results.items()], parent_tool_use_id=checkpoint['parent']['id'] or None)

    async def run(self, input_data, options, prompt):
        if os.name != 'posix' or options.session_store or options.fork_session or options.resume_session_at or options.continue_conversation:
            raise ValueError('Native child recovery requires exclusive local POSIX sessions without custom store, fork or rewind')
        self.frontend_names = {f'mcp__ag_ui__{t.name}' for t in input_data.tools}
        self.config = copy.copy(self.config)
        self.config.tools = list(set(self.config.tools) | self.frontend_names | set(self.automatic))
        self.session_id = options.resume or options.session_id
        if not self.session_id:
            raise ValueError('Native child recovery requires an explicit session_id for new sessions')
        release = await self.config.acquire(self.session_id)
        try:
            checkpoints = [self.history().root(), *self.history().children(True)] if options.resume else []
            known = [c for cp in checkpoints for c in cp['calls']]
            ids = [r.interrupt_id for r in (input_data.resume or [])]
            if len(set(ids)) != len(ids) or any(key not in {c['id'] for c in known} for key in ids):
                raise ValueError('Answer does not match the original tool call or is duplicated')
            for message in (m for m in input_data.messages if m.role == 'tool'):
                if not any(c['id'] == message.tool_call_id for c in known):
                    raise ValueError('Frontend result does not match original native history')
                if sum(m.role == 'tool' and m.tool_call_id == message.tool_call_id for m in input_data.messages) > 1:
                    raise ValueError('Duplicate or conflicting tool answers')
            for cp in checkpoints:
                async for _ in self.answer_checkpoint(input_data, cp, True):
                    pass
            async for message in self.answer_automatic(checkpoints):
                yield message
            for cp in checkpoints:
                async for message in self.answer_checkpoint(input_data, cp):
                    yield message
            while options.resume:
                checkpoints = [self.history().root(), *self.history().children()]
                if self.interrupt_pending(checkpoints):
                    return
                children = [c for c in checkpoints if c['childId']]
                if not children:
                    break
                checkpoint = next((c for c in children if not c.get('dependencies')), None)
                if checkpoint is None:
                    raise ValueError('Unresolved or cyclic native child dependencies')
                self.completed = self.gate_held = self.resume_issued = self.pausing = False
                self.bridge_results = {}
                if checkpoint['final'] is None:
                    self.bridge = True
                    async for child_message in self.execute(options, f"Resume child {checkpoint['childId']} with SendMessage, message exactly: {MESSAGE}", checkpoint):
                        yield child_message
                    self.history().settle_bridge(checkpoint, self.bridge_results)
                    if self.pausing:
                        async for message in self.answer_automatic([self.history().root(), *self.history().children()]):
                            yield message
                        if self.interrupt_pending([self.history().root(), *self.history().children()]):
                            return
                    if not self.completed or not self.gate_held:
                        raise self.failure or RuntimeError('Child recovery did not complete while the parent was held')
                    self.bridge = False
                completed = next(c for c in self.history().children() if c['childId'] == checkpoint['childId'])
                self.history().repair(checkpoint)
                if not checkpoint.get('parentResolved'):
                    owner = next((c for c in children if c['childId'] == checkpoint.get('ownerAgentId')), None)
                    yield UserMessage(content=[ToolResultBlock(tool_use_id=checkpoint['parent']['id'], content=completed['final'], is_error=False)], parent_tool_use_id=owner['parent']['id'] if owner else None)
                prompt = 'Continue from the completed child results recorded in your history.'
            if options.resume:
                self.history().assert_root_ready()
            async for message in self.execute(options, prompt):
                yield message
            if self.pausing:
                async for message in self.answer_automatic([self.history().root(), *self.history().children()]):
                    yield message
                if not self.interrupt_pending([self.history().root(), *self.history().children()]):
                    raise RuntimeError('Approval was not durably recorded')
        finally:
            self.stop()
            await release()

    async def execute(self, options, prompt, checkpoint=None):
        self.stopped = False
        opts = copy.copy(options)
        opts.session_id = None if options.resume else options.session_id
        opts.extra_args = {**(options.extra_args or {}), 'await-initialize': None}

        async def pre(data, tool_id, context):
            if self.bridge and not data.get('agent_id'):
                args = data.get('tool_input', {})
                if not self.resume_issued and data['tool_name'] == 'SendMessage' and args.get('to') == checkpoint['childId'] and args.get('message') == MESSAGE:
                    self.resume_issued = True
                    return {}
                self.bridge_results[data['tool_use_id']] = dict(content='Parent tool was not executed: held during child recovery', is_error=True)
                return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': 'Parent is held during child recovery'}}
            if data['tool_name'] in self.config.tools and data['tool_name'] not in self.automatic:
                self.pausing = True
                deadline = asyncio.get_running_loop().time() + 4
                while True:
                    try:
                        saved = next((c for c in self.history().children() if c['childId'] == data['agent_id']), None) if data.get('agent_id') else self.history().root()
                        if saved and any(c['id'] == data['tool_use_id'] for c in saved['pending']):
                            if self.bridge or all(c['pending'] or c.get('dependencies') or c['final'] is not None for c in self.history().children()):
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
                        if not self.bridge or getattr(message, 'parent_tool_use_id', None):
                            yield message
                        if not self.bridge and isinstance(message, ResultMessage):
                            if any(c['final'] is None for c in self.history().children()):
                                continue
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
