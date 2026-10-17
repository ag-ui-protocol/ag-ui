"""Host-owned session bindings; SDK transcripts remain in native storage."""
from copy import deepcopy
from dataclasses import dataclass, asdict, is_dataclass
from typing import Any, Protocol

@dataclass
class SessionBinding:
    session_id: str
    profile: str
    pending: dict[str, Any] | None = None
    frontend_tools: list[dict[str, Any]] | None = None

class SessionBindingStore(Protocol):
    async def load(self, thread_id: str) -> SessionBinding | None: ...
    async def save(self, thread_id: str, binding: SessionBinding) -> None: ...

class RecoveryRun:
    def __init__(self, binding: SessionBinding | None, input_data: Any, defer_tools=()):
        self.binding = binding
        self.decision = None
        self.consumed = False
        self.delivered = False
        self.failure = None
        self.frontend_result = None
        self.tools = deepcopy(binding.frontend_tools) if binding and binding.pending and binding.frontend_tools is not None else [tool.model_dump() for tool in getattr(input_data, 'tools', [])]
        self.frontend_names = {f"mcp__ag_ui__{tool['name']}" for tool in self.tools} | set(defer_tools)
        pending = binding.pending if binding else None
        messages = getattr(input_data, 'messages', [])
        if pending and pending['name'].startswith('mcp__ag_ui__'):
            results = [m for m in messages if m.role == 'tool' and m.tool_call_id == pending['id']]
            if len(results) > 1:
                raise ValueError('Multiple results for one deferred tool call')
            if results:
                self.frontend_result = {'content': results[0].content, 'error': getattr(results[0], 'error', None)}
                self.decision = {'behavior': 'allow'}
        if messages and messages[-1].role == 'tool' and self.frontend_result is None:
            raise ValueError('No saved SDK deferral matches this frontend result')
        responses = getattr(input_data, 'resume', None) or []
        if responses and self.frontend_result is not None:
            raise ValueError('Submit either a native decision or a frontend result, not both')
        if len(responses) > 1:
            raise ValueError('Claude SDK durable deferral supports one tool call at a time.')
        if responses:
            response = responses[0]
            if not binding or not binding.pending or response.interrupt_id != binding.pending['id']:
                raise ValueError('No saved SDK deferral matches this approval; historical callbacks cannot be recovered.')
            payload = {'behavior': 'deny', 'message': 'Cancelled by user'} if response.status == 'cancelled' else response.payload
            if not isinstance(payload, dict) or payload.get('behavior') not in ('allow', 'deny'):
                raise ValueError('Approval payload requires behavior: allow or deny.')
            self.decision = payload

    def resolve_frontend_result(self, name, args):
        pending = self.binding.pending if self.binding else None
        if not self.consumed or self.delivered or self.frontend_result is None or not pending or pending['name'] != f'mcp__ag_ui__{name}' or args != pending['input']:
            raise ValueError('Frontend tool invocation has no matching resumed result')
        self.delivered = True
        return self.frontend_result

    @property
    def awaiting_decision(self):
        return bool(self.binding and self.binding.pending and not self.decision)

    @property
    def outcome(self):
        pending = self.binding.pending if self.binding else None
        if not pending:
            return None
        if pending['name'].startswith('mcp__ag_ui__'):
            return {'type': 'success', 'pendingToolCallIds': [pending['id']]}
        return {'type': 'interrupt', 'interrupts': self.interrupts}

    @property
    def interrupts(self):
        pending = self.binding.pending if self.binding else None
        return [{'id': pending['id'], 'toolCallId': pending['id'], 'reason': 'tool_approval',
                 'metadata': {'source': 'claude-sdk-deferred', 'toolName': pending['name'], 'input': pending['input']}}] if pending else []

    async def hook(self, input_data, tool_use_id, context):
        pending = self.binding.pending if self.binding else None
        if input_data.get('hook_event_name') != 'PreToolUse':
            return {}
        if not pending or self.consumed:
            return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'defer'}} if input_data['tool_name'] in self.frontend_names else {}
        if input_data.get('tool_use_id') != pending['id'] or input_data['tool_name'] != pending['name'] or input_data['tool_input'] != pending['input']:
            self.failure = 'Resumed tool does not match the saved SDK deferral.'
            return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': self.failure}}
        output = {'hookEventName': 'PreToolUse', 'permissionDecision': 'defer'}
        if self.decision:
            self.consumed = True
            output['permissionDecision'] = self.decision['behavior']
            if 'message' in self.decision:
                output['permissionDecisionReason'] = self.decision['message']
            if 'updatedInput' in self.decision:
                output['updatedInput'] = self.decision['updatedInput']
        return {'hookSpecificOutput': output}

    def observe_tool_result(self, tool_use_id):
        if not self.binding or not self.binding.pending or self.binding.pending['id'] != tool_use_id:
            return False
        if not self.consumed:
            raise ValueError('SDK resolved the saved call without applying its approval hook.')
        if self.frontend_result is not None and not self.delivered:
            raise ValueError('SDK omitted the submitted frontend result.')
        self.binding.pending = None
        return True

    def observe(self, session_id, profile, result=None):
        if self.failure:
            raise ValueError(self.failure)
        if self.binding and session_id != self.binding.session_id:
            raise ValueError('SDK changed the original session UUID during resume.')
        if not self.binding:
            self.binding = SessionBinding(session_id, profile)
        self.binding.frontend_tools = deepcopy(self.tools)
        if result is None:
            return
        reason = getattr(result, 'stop_reason', None)
        if reason == 'tool_deferred_unavailable':
            raise ValueError('Deferred tool is unavailable. Restore the original tool/MCP configuration before resuming.')
        if reason == 'tool_deferred':
            pending = getattr(result, 'deferred_tool_use', None)
            if is_dataclass(pending):
                pending = asdict(pending)
            if not isinstance(pending, dict) or not pending.get('id') or not pending.get('name') or not isinstance(pending.get('input'), dict):
                raise ValueError('SDK deferral is missing its original tool identity/input.')
            self.binding.pending = pending
        elif not getattr(result, 'is_error', False) and self.binding.pending:
            if self.frontend_result is not None and not self.delivered:
                raise ValueError('SDK did not deliver the submitted frontend result to the original tool')
            if not self.consumed:
                raise ValueError('SDK did not replay the saved deferred tool call.')
            self.binding.pending = None
