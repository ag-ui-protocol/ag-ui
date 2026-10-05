"""Config-construction tests for ``AntigravityAgent._build_agent``.

``_build_agent`` is what decides which harness the run talks to, whether cold
resume is possible, and whether the SDK's mandatory safety guard is satisfied.
It runs entirely offline -- constructing an ``Agent`` does not start the Go
subprocess -- so the resulting config object can be asserted on directly.
"""

import pytest
from ag_ui.core import RunAgentInput, Tool as AGUITool, UserMessage
from google.antigravity import CapabilitiesConfig, LocalOpenAIAgentConfig
from google.antigravity import types as ag_types

from ag_ui_antigravity.agent import AntigravityAgent, _ResumableOpenAIConfig
from ag_ui_antigravity.ui_bridge import UIBridge

# The SDK validates conversation ids as >= 32 characters.
PREVIOUS_CONVERSATION_ID = "c" * 32


def run_input(**kwargs):
    defaults = dict(
        thread_id="t1",
        run_id="r1",
        state={},
        messages=[UserMessage(id="m1", role="user", content="hi")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    defaults.update(kwargs)
    return RunAgentInput(**defaults)


def frontend_tool(name="set_theme"):
    return AGUITool(
        name=name, description="", parameters={"type": "object", "properties": {}}
    )


def build(agent, *, input_data=None, previous_conversation_id=None, bridge=None):
    bridge = bridge or UIBridge()
    built = agent._build_agent(
        bridge, input_data or run_input(), previous_conversation_id
    )
    return built._config, bridge


READ_TOOLS = ["get_app_context", "get_shared_state"]


def tool_names(config):
    return [t.__name__ for t in config.tools]


class TestModelSelection:
    async def test_base_url_selects_the_openai_compatible_config(self):
        config, _ = build(AntigravityAgent(base_url="http://host:1234", model="gpt-4o"))
        assert isinstance(config, _ResumableOpenAIConfig)
        assert config.base_url == "http://host:1234"
        assert config.model == "gpt-4o"

    async def test_no_base_url_selects_the_native_gemini_config(self):
        config, _ = build(AntigravityAgent(model="gemini-3-pro", api_key="secret"))
        assert not isinstance(config, LocalOpenAIAgentConfig)
        assert config.model == "gemini-3-pro"
        assert config.api_key == "secret"


class TestEndpoint:
    def endpoint(self, **kwargs):
        return ag_types.GeminiAPIEndpoint(
            base_url="http://mock:4010",
            http_headers={"X-AIMock-Context": "demo"},
            **kwargs,
        )

    def targets(self, config):
        return {t.types[0]: t for t in config.models}

    async def test_endpoint_stays_on_the_native_gemini_config(self):
        config, _ = build(AntigravityAgent(endpoint=self.endpoint()))
        assert not isinstance(config, LocalOpenAIAgentConfig)

    async def test_text_and_image_models_are_pinned_to_the_endpoint(self):
        # A missing model type is filled with a default target on Google's own
        # endpoint, which would bypass a mock and demand a GEMINI_API_KEY.
        config, _ = build(
            AntigravityAgent(model="gemini-2.5-flash", endpoint=self.endpoint())
        )
        targets = self.targets(config)
        assert set(targets) == {ag_types.ModelType.TEXT, ag_types.ModelType.IMAGE}
        assert targets[ag_types.ModelType.TEXT].name == "gemini-2.5-flash"
        for target in targets.values():
            assert target.endpoint.base_url == "http://mock:4010"
            assert target.endpoint.http_headers == {"X-AIMock-Context": "demo"}

    async def test_api_key_fills_an_endpoint_without_one(self):
        config, _ = build(AntigravityAgent(endpoint=self.endpoint(), api_key="k"))
        assert {t.endpoint.api_key for t in config.models} == {"k"}

    async def test_the_endpoint_own_api_key_wins(self):
        config, _ = build(
            AntigravityAgent(endpoint=self.endpoint(api_key="own"), api_key="k")
        )
        assert {t.endpoint.api_key for t in config.models} == {"own"}

    async def test_endpoint_and_base_url_are_mutually_exclusive(self):
        with pytest.raises(ValueError, match="not both"):
            AntigravityAgent(base_url="http://host:1234", endpoint=self.endpoint())


class TestResume:
    async def test_previous_conversation_id_enables_cold_resume(self):
        config, _ = build(
            AntigravityAgent(),
            previous_conversation_id=PREVIOUS_CONVERSATION_ID,
        )
        assert config.conversation_id == PREVIOUS_CONVERSATION_ID
        assert (
            config.session_continuation_mode
            == ag_types.SessionContinuationMode.CREATE_OR_RESUME
        )

    async def test_fresh_thread_does_not_request_resume(self):
        config, _ = build(AntigravityAgent())
        assert config.conversation_id is None
        assert (
            config.session_continuation_mode
            != ag_types.SessionContinuationMode.CREATE_OR_RESUME
        )

    async def test_openai_strategy_carries_the_continuation_mode(self, tmp_path):
        """google-antigravity 0.1.8 drops the field on the OpenAI path.

        ``LocalAgentConfig.create_strategy`` forwards it but
        ``LocalOpenAIAgentConfig.create_strategy`` does not, silently disabling
        cold resume; ``_ResumableOpenAIConfig`` restores parity.
        """
        kwargs = dict(
            base_url="http://host:1",
            model="gpt-4o",
            save_dir=str(tmp_path),
            session_continuation_mode=(
                ag_types.SessionContinuationMode.CREATE_OR_RESUME
            ),
        )
        patched = _ResumableOpenAIConfig(**kwargs).create_strategy(
            tool_runner=None, hook_runner=None
        )
        unpatched = LocalOpenAIAgentConfig(**kwargs).create_strategy(
            tool_runner=None, hook_runner=None
        )
        assert (
            patched._session_continuation_mode
            == ag_types.SessionContinuationMode.CREATE_OR_RESUME
        )
        assert unpatched._session_continuation_mode is None


class TestTools:
    async def test_client_tools_become_parking_antigravity_tools(self):
        config, bridge = build(
            AntigravityAgent(), input_data=run_input(tools=[frontend_tool("set_theme")])
        )
        assert tool_names(config) == ["set_theme"]
        assert bridge.frontend_tool_names == {"set_theme"}

    async def test_frontend_tools_can_be_disabled(self):
        config, bridge = build(
            AntigravityAgent(enable_frontend_tools=False),
            input_data=run_input(tools=[frontend_tool()]),
        )
        assert tool_names(config) == []
        assert bridge.frontend_tool_names == set()

    async def test_static_tools_are_kept_alongside_client_tools(self):
        def lookup_weather(city: str) -> str:
            """Looks up the weather."""
            return "sunny"

        config, _ = build(
            AntigravityAgent(tools=[lookup_weather]),
            input_data=run_input(tools=[frontend_tool("set_theme")]),
        )
        assert tool_names(config) == ["lookup_weather", "set_theme"]


READ_TOOLS_ON = dict(experimental_app_context=True, experimental_app_state=True)


class TestReadTools:
    async def test_read_tools_are_off_by_default(self):
        config, _ = build(AntigravityAgent())
        assert tool_names(config) == []

    async def test_each_read_tool_is_opted_into_separately(self):
        config, _ = build(AntigravityAgent(experimental_app_context=True))
        assert tool_names(config) == ["get_app_context"]
        config, _ = build(AntigravityAgent(experimental_app_state=True))
        assert tool_names(config) == ["get_shared_state"]
        config, _ = build(AntigravityAgent(**READ_TOOLS_ON))
        assert tool_names(config) == READ_TOOLS

    async def test_a_server_tool_of_the_same_name_wins(self):
        def get_shared_state() -> dict:
            """The app's own version."""
            return {"mine": True}

        config, _ = build(AntigravityAgent(tools=[get_shared_state], **READ_TOOLS_ON))
        assert tool_names(config) == ["get_shared_state", "get_app_context"]
        assert config.tools[0].__wrapped__ is get_shared_state

    async def test_a_client_tool_of_the_same_name_wins(self):
        config, bridge = build(
            AntigravityAgent(**READ_TOOLS_ON),
            input_data=run_input(tools=[frontend_tool("get_app_context")]),
        )
        assert tool_names(config) == ["get_app_context", "get_shared_state"]
        assert bridge.frontend_tool_names == {"get_app_context"}

    async def test_read_tools_return_the_runs_context_and_state_silently(self):
        from ag_ui.core import Context

        agent = AntigravityAgent(**READ_TOOLS_ON)
        config, bridge = build(agent)
        bridge.adopt_client_state({"theme": "dark"})
        bridge.adopt_client_context(
            [Context(description="User name", value="Ada")]
        )
        tools = {t.__name__: t for t in config.tools}
        assert await tools["get_app_context"]() == [
            {"description": "User name", "value": "Ada"}
        ]
        assert await tools["get_shared_state"]() == {"theme": "dark"}
        # No tool card: the reads emit no TOOL_CALL_* events.
        assert bridge.drain() == []


class TestHooksAndPolicies:
    async def test_ask_question_hook_is_registered_by_default(self):
        config, _ = build(AntigravityAgent())
        assert len(config.hooks) == 1

    async def test_ask_question_hook_can_be_disabled(self):
        config, _ = build(AntigravityAgent(enable_ask_question=False))
        assert config.hooks == []

    async def test_tool_approval_adds_the_decide_hook(self):
        config, _ = build(AntigravityAgent(tool_approval=True))
        assert len(config.hooks) == 2

    async def test_without_approval_an_allow_all_policy_satisfies_the_safety_guard(self):
        """The SDK refuses to start on write/MCP tools with no policy or hook."""
        config, _ = build(AntigravityAgent(tool_approval=False))
        assert "allow_all" in [p.name for p in config.policies]

    async def test_approval_hook_replaces_the_allow_all_policy(self):
        """The decide hook is itself the safety guard; allow_all would defeat it."""
        config, _ = build(AntigravityAgent(tool_approval=True))
        assert "allow_all" not in [p.name for p in (config.policies or [])]


class TestOptionalFields:
    async def test_workspaces_default_to_the_process_cwd(self):
        import os

        config, _ = build(AntigravityAgent())
        assert config.workspaces == [os.getcwd()]

    async def test_explicit_workspaces_are_forwarded(self, tmp_path):
        config, _ = build(AntigravityAgent(workspaces=[str(tmp_path)]))
        assert config.workspaces == [str(tmp_path)]

    async def test_subagents_switch_the_capability_on(self):
        subagent = ag_types.SubagentConfig(name="researcher", description="researches")
        config, _ = build(AntigravityAgent(subagents=[subagent]))
        assert config.capabilities.enable_subagents is True
        assert [s.name for s in config.subagents] == ["researcher"]

    async def test_no_subagents_leaves_the_capability_off(self):
        config, _ = build(AntigravityAgent())
        assert config.capabilities.enable_subagents is False

    async def test_explicit_capabilities_override_the_derived_default(self):
        subagent = ag_types.SubagentConfig(name="researcher", description="researches")
        config, _ = build(
            AntigravityAgent(
                capabilities=CapabilitiesConfig(enable_subagents=False),
                subagents=[subagent],
            )
        )
        assert config.capabilities.enable_subagents is False

    async def test_system_instructions_and_save_dir_are_forwarded(self, tmp_path):
        config, _ = build(
            AntigravityAgent(system_instructions="be terse", save_dir=str(tmp_path))
        )
        assert "be terse" in str(config.system_instructions)
        assert config.save_dir == str(tmp_path)


class TestLifecycle:
    async def test_session_manager_is_exposed(self):
        agent = AntigravityAgent()
        assert agent.session_manager is agent._sessions

    async def test_an_injected_session_manager_is_used_verbatim(self):
        from ag_ui_antigravity.session_manager import SessionManager

        injected = SessionManager(max_sessions=3)
        assert AntigravityAgent(session_manager=injected).session_manager is injected

    async def test_close_stops_the_session_manager(self):
        agent = AntigravityAgent()
        agent._sessions.start()
        await agent.close()
        assert agent._sessions._cleanup_task is None
