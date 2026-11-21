"""Host-owned session bindings; SDK transcripts remain in native storage."""
import asyncio
from copy import deepcopy
from dataclasses import dataclass, asdict, is_dataclass
from typing import Any, Protocol
from .utils import build_agui_tool_message

@dataclass
class SessionBinding:
    session_id: str
    profile: str
    pending: dict[str, Any] | None = None
    frontend_tools: list[dict[str, Any]] | None = None
    unsupported_pending_tools: list[dict[str, Any]] | None = None

class SessionBindingStore(Protocol):
    async def load(self, thread_id: str) -> SessionBinding | None: ...
    async def save(self, thread_id: str, binding: SessionBinding) -> None: ...

class UnmatchedToolResult(ValueError):
    def __init__(self):
        super().__init__('No saved SDK deferral matches this frontend result')


def historical_tool_results(messages):
    results = []
    for item in messages:
        message = item.message
        if not isinstance(message, dict) or not isinstance(message.get('content'), list):
            continue
        for block in message['content']:
            if isinstance(block, dict) and block.get('type') == 'tool_result' and isinstance(block.get('tool_use_id'), str):
                results.append(build_agui_tool_message(block['tool_use_id'], block.get('content'), block.get('is_error') is True))
    return results


class RecoveryRun:
    @classmethod
    async def restore(cls, binding, input_data, defer_tools, load_history):
        try:
            return cls(binding, input_data, defer_tools)
        except UnmatchedToolResult:
            if binding is None:
                raise
            # Only the host's original SDK transcript establishes historical results.
            return cls(binding, input_data, defer_tools, await load_history())

    def __init__(self, binding: SessionBinding | None, input_data: Any, defer_tools=(), historical_results=()):
        self.save_lock = asyncio.Lock()
        self.binding = binding
        self.assert_supported()
        self.deferred_tools = {}
        self.child_tools = {}
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
                # The protocol result event carries error status in metadata;
                # the client reducer preserves this through a cold restart.
                metadata = getattr(results[0], 'metadata', None) or {}
                marker = metadata.get('ag-ui:tool-result') if isinstance(metadata, dict) else None
                error = getattr(results[0], 'error', None)
                if error is None and isinstance(marker, dict) and isinstance(marker.get('error'), str):
                    error = marker['error']
                self.frontend_result = {'content': results[0].content, 'error': error}
                self.decision = {'behavior': 'allow'}
        responses = getattr(input_data, 'resume', None) or []
        if responses and (self.frontend_result is not None or any(m.role == 'tool' and pending and m.tool_call_id == pending['id'] for m in messages)):
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
        # Every trailing result must match the pending frontend call or trusted history.
        for message in reversed(messages):
            if message.role != 'tool':
                break
            if sum(m.role == 'tool' and m.tool_call_id == message.tool_call_id for m in messages) > 1:
                raise ValueError('Multiple results for one deferred tool call')
            if self.frontend_result is not None and message.tool_call_id == pending['id']:
                continue
            saved = [result for result in historical_results if result.tool_call_id == message.tool_call_id]
            # Client reduction can retain an error only in result-event metadata.
            # Keep an explicit error authoritative and accept only string markers.
            metadata = getattr(message, 'metadata', None)
            marker = metadata.get('ag-ui:tool-result') if isinstance(metadata, dict) else None
            error = getattr(message, 'error', None)
            if error is None and isinstance(marker, dict) and isinstance(marker.get('error'), str):
                error = marker['error']
            if ((pending and message.tool_call_id == pending['id']) or len(saved) != 1
                    or saved[0].content != message.content
                    or getattr(saved[0], 'error', None) != error):
                raise UnmatchedToolResult()

    def observe_child_tool(self, tool, parent_tool_use_id):
        self.child_tools[tool['id']] = deepcopy({**tool, 'parentToolUseId': parent_tool_use_id})

    def checkpoint_deferred(self, session_id, profile):
        if len(self.deferred_tools) < 2:
            return False
        if not session_id:
            raise ValueError('Deferred batch is missing its original session UUID.')
        self.observe(session_id, profile)
        self.binding.unsupported_pending_tools = deepcopy(list(self.deferred_tools.values()))
        return True

    def assert_supported(self):
        if self.binding and any(tool.get('parentToolUseId') for tool in self.binding.unsupported_pending_tools or []):
            raise ValueError("Claude SDK child tool calls remain unresolved. Original child identities are retained for diagnosis; child deferral recovery is unsupported.")
        if self.binding and len(self.binding.unsupported_pending_tools or []) > 1:
            raise ValueError("Claude SDK cannot resume multiple pending tool calls. The original pending batch is retained; SDK batch recovery is unsupported.")

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
            if input_data['tool_name'] in self.frontend_names:
                self.deferred_tools[input_data['tool_use_id']] = deepcopy({'id': input_data['tool_use_id'], 'name': input_data['tool_name'], 'input': input_data['tool_input']})
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

    def observe_tool_result(self, tool_use_id, parent_tool_use_id=None):
        child = self.child_tools.get(tool_use_id)
        if child and child['parentToolUseId'] != parent_tool_use_id:
            return False
        self.child_tools.pop(tool_use_id, None)
        # A correlated child result can complete the last outstanding call in a batch.
        observed = self.deferred_tools.pop(tool_use_id, None) is not None or child is not None
        changed = self._observe_pending_tool_result(tool_use_id)
        if observed and not self.deferred_tools and not self.child_tools and self.binding and self.binding.unsupported_pending_tools:
            self.binding.unsupported_pending_tools = None
            return True
        return changed

    def _observe_pending_tool_result(self, tool_use_id):
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
            self.deferred_tools[pending['id']] = deepcopy(pending)
        elif not getattr(result, 'is_error', False) and self.binding.pending:
            if self.frontend_result is not None and not self.delivered:
                raise ValueError('SDK did not deliver the submitted frontend result to the original tool')
            if not self.consumed:
                raise ValueError('SDK did not replay the saved deferred tool call.')
            self.binding.pending = None
        if len(self.deferred_tools) > 1 or self.child_tools:
            self.binding.unsupported_pending_tools = list({**self.deferred_tools, **self.child_tools}.values())
            # Child identities are diagnostic, never parent-session resume targets.
            if self.binding.pending and self.binding.pending['id'] in self.child_tools:
                self.binding.pending = None
        elif not getattr(result, 'is_error', False):
            self.binding.unsupported_pending_tools = None


def unresolved_tool_uses(messages):
    """Read-only diagnostic for legacy bindings that retained only the last call."""
    pending = {}
    for item in messages:
        message = item.message
        if not isinstance(message, dict) or not isinstance(message.get('content'), list):
            continue
        for block in message['content']:
            if not isinstance(block, dict):
                continue
            if (block.get('type') == 'tool_use' and isinstance(block.get('id'), str)
                    and isinstance(block.get('name'), str) and isinstance(block.get('input'), dict)):
                pending[block['id']] = deepcopy({key: block[key] for key in ('id', 'name', 'input')})
            elif block.get('type') == 'tool_result':
                pending.pop(block.get('tool_use_id'), None)
    return list(pending.values())
