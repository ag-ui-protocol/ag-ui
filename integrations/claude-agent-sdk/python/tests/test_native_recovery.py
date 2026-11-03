import pytest
from unittest.mock import AsyncMock
from claude_agent_sdk import ClaudeAgentOptions
from ag_ui.core import RunAgentInput
from ag_ui_claude_sdk.native_history import NativeHistory
from ag_ui_claude_sdk.native_recovery import NativeChildRecovery, NativeChildRecoveryConfig

@pytest.mark.asyncio
@pytest.mark.parametrize('background', [False, True])
async def test_bridge_denies_parent_agent(monkeypatch, background):
    checkpoint = dict(parentPath='unused', childPath='unused', childId='child', parent=dict(id='parent'), pending=[], calls=[], final=None)
    monkeypatch.setattr(NativeHistory, 'children', lambda self, *args: [checkpoint])
    monkeypatch.setattr(NativeHistory, 'root', lambda self: {**checkpoint, 'childId': '', 'parent': {'id': ''}})
    decisions = []
    class Transport:
        finished_normally = False
        def __init__(self, options): pass
        def kill_now(self): pass
    class Client:
        def __init__(self, options, transport): self.options = options
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def query(self, *args, **kwargs): pass
        async def receive_messages(self):
            hook = self.options.hooks['PreToolUse'][-1].hooks[0]
            decisions.append(await hook(dict(tool_name='Agent', tool_use_id='nested', tool_input=dict(run_in_background=background)), 'nested', {}))
            raise RuntimeError('fixture stopped')
            yield
    monkeypatch.setattr('ag_ui_claude_sdk.native_recovery.IsolatedTransport', Transport)
    monkeypatch.setattr('ag_ui_claude_sdk.native_recovery.ClaudeSDKClient', Client)
    recovery = NativeChildRecovery(NativeChildRecoveryConfig('unused', ['Read'], AsyncMock(), AsyncMock(return_value=AsyncMock())))
    input_data = RunAgentInput(thread_id='thread', run_id='run', messages=[], tools=[], context=[], state={}, forwarded_props={})
    with pytest.raises(RuntimeError, match='fixture stopped'):
        async for _ in recovery.run(input_data, ClaudeAgentOptions(resume='11111111-1111-4111-8111-111111111111'), 'continue'): pass
    assert decisions[0]['hookSpecificOutput']['permissionDecision'] == 'deny'
