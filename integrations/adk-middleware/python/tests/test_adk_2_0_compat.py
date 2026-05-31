"""Regression tests for ADK 2.0 compatibility (ag-ui#1389 and ag-ui#1669).

Coverage:
- #1389: AGUIToolset uses bind() delegation so ADK 2.0's eager Runner
  tool cache stays valid; super().__init__ initializes cache attrs.
- #1669: Workflow roots receive FunctionResponse in new_message, not the
  #1534 empty-text placeholder, so Workflow._extract_resume_inputs can
  rehydrate from the interrupt.

Runs against whichever ``google-adk`` is installed; Workflow-only cases
skip on ADK 1.x via the ``google.adk.workflow`` ImportError gate.
"""

from __future__ import annotations

import asyncio
import time
from typing import AsyncGenerator, List
from unittest.mock import MagicMock, patch

import pytest

from ag_ui.core import (
    AssistantMessage,
    BaseEvent,
    FunctionCall,
    RunStartedEvent,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui.core.types import RunAgentInput
from google.adk.agents import LlmAgent as Agent
from google.adk.tools.base_toolset import BaseToolset as ADKBaseToolset
from google.genai import types

from ag_ui_adk import ADKAgent
from ag_ui_adk.agui_toolset import AGUIToolset
from ag_ui_adk.client_proxy_toolset import ClientProxyToolset
from ag_ui_adk.session_manager import SessionManager


# ---------------------------------------------------------------------------
# ag-ui#1389 — AGUIToolset delegation pattern (bind/unbind)
# ---------------------------------------------------------------------------


class TestAGUIToolsetReplacement:
    """Verify the per-run replacement pattern (ag-ui#1746 follow-up: replaces the
    bind/unbind delegation, which stored per-run state on a shared instance and
    was not concurrency-safe)."""

    def test_construction_initializes_baseToolset_state(self) -> None:
        """AGUIToolset.__init__ calls ``super().__init__()`` so ADK 2.0's
        ``BaseToolset`` cache attributes (``_use_invocation_cache`` et al.) are
        initialized and the placeholder is a well-formed toolset."""
        toolset = AGUIToolset(tool_filter=['x'], tool_name_prefix='pfx_')
        # On ADK 2.0 these attrs must exist; on ADK 1.x super().__init__ is a
        # no-op so the absence is also OK there.
        if hasattr(ADKBaseToolset, '_use_invocation_cache') or any(
            'invocation_cache' in name
            for name in dir(toolset)
        ):
            assert hasattr(toolset, '_use_invocation_cache')

    def test_placeholder_get_tools_raises(self) -> None:
        """The placeholder is replaced per-run before use; calling
        ``get_tools()`` on it directly means the substitution didn't happen
        (misconfiguration), so it raises."""
        toolset = AGUIToolset()
        with pytest.raises(NotImplementedError, match="placeholder"):
            asyncio.run(toolset.get_tools())

    @pytest.mark.asyncio
    async def test_placeholder_replaced_per_run(self) -> None:
        """``ADKAgent`` replaces the ``AGUIToolset`` placeholder with a per-run
        ``ClientProxyToolset`` in the per-run agent copy, leaving the
        construction-time placeholder untouched — so concurrent runs stay
        isolated (no shared mutable delegate)."""
        agui = AGUIToolset(tool_filter=['probe_tool'])
        root_agent = Agent(name="probe_agent", instruction="probe", tools=[agui])

        captured: dict = {}

        async def _noop(self, **kwargs):
            captured.update(kwargs)
            return None

        with patch.object(ADKAgent, "_run_adk_in_background", _noop):
            adk_agent = ADKAgent(
                adk_agent=root_agent,
                app_name="probe_app",
                user_id="probe_user",
                use_in_memory_services=True,
            )
            run_input = RunAgentInput(
                thread_id="probe_thread",
                run_id="probe_run",
                messages=[UserMessage(id="m1", role="user", content="hi")],
                context=[],
                state={},
                tools=[Tool(
                    name="probe_tool",
                    description="probe tool",
                    parameters={"type": "object", "properties": {}},
                )],
                forwarded_props={},
            )
            exec_state = await adk_agent._start_background_execution(run_input)
            await asyncio.gather(exec_state.task, return_exceptions=True)

        per_run_agent = captured["adk_agent"]
        replaced = per_run_agent.tools[0]
        # Placeholder was replaced with a per-run ClientProxyToolset carrying
        # this run's filter.
        assert isinstance(replaced, ClientProxyToolset)
        assert replaced.tool_filter == ['probe_tool']
        # Construction-time placeholder untouched (not mutated, not shared in).
        assert root_agent.tools[0] is agui
        assert isinstance(root_agent.tools[0], AGUIToolset)

    @pytest.mark.asyncio
    async def test_swapped_in_toolset_resolves_nonempty_via_get_tools_with_prefix(self) -> None:
        """#1389 regression guard (replaces the removed object-identity test).

        The actual #1389 failure was an *empty* tool list: in ADK 2.x a toolset
        that is not a well-formed ``BaseToolset`` (no ``super().__init__()`` ->
        missing ``_use_invocation_cache``) is silently dropped to ``[]`` by
        ``llm_agent._convert_tool_union_to_tools``'s ``try/except``. Assert the
        per-run ``ClientProxyToolset`` the middleware swaps in resolves
        *non-empty* tools through ``get_tools_with_prefix`` (the ADK path that
        reads ``_use_invocation_cache``), and that the agent's
        ``canonical_tools`` still exposes the frontend tool -- so we cannot
        silently regress to the empty-tool-list symptom.
        """
        agui = AGUIToolset()  # no filter -> every frontend tool passes through
        root_agent = Agent(
            name="probe_agent",
            model="gemini-2.5-flash",
            instruction="probe",
            tools=[agui],
        )

        captured: dict = {}

        async def _noop(self, **kwargs):
            captured.update(kwargs)
            return None

        with patch.object(ADKAgent, "_run_adk_in_background", _noop):
            adk_agent = ADKAgent(
                adk_agent=root_agent,
                app_name="probe_app",
                user_id="probe_user",
                use_in_memory_services=True,
            )
            run_input = RunAgentInput(
                thread_id="probe_thread",
                run_id="probe_run",
                messages=[UserMessage(id="m1", role="user", content="hi")],
                context=[],
                state={},
                tools=[Tool(
                    name="frontend_tool",
                    description="a frontend tool",
                    parameters={"type": "object", "properties": {}},
                )],
                forwarded_props={},
            )
            exec_state = await adk_agent._start_background_execution(run_input)
            await asyncio.gather(exec_state.task, return_exceptions=True)

        swapped_in = captured["adk_agent"].tools[0]
        assert isinstance(swapped_in, ClientProxyToolset)

        # The #1389 failure mode was *empty* tools through this exact path
        # (get_tools_with_prefix reads _use_invocation_cache on ADK 2.x). A
        # well-formed toolset resolves the frontend tool rather than [].
        resolved = await swapped_in.get_tools_with_prefix()
        assert resolved, "swapped-in ClientProxyToolset resolved no tools (#1389 regression)"
        assert [t.name for t in resolved] == ["frontend_tool"]

        # End-to-end: the agent's real resolution entrypoint (which would drop a
        # malformed toolset to [] via try/except) still exposes the tool.
        canonical = await captured["adk_agent"].canonical_tools()
        assert "frontend_tool" in [t.name for t in canonical]


# ---------------------------------------------------------------------------
# ag-ui#1669 — Workflow root HITL rehydrate gate
# ---------------------------------------------------------------------------


class TestWorkflowRootDetection:
    """Verify the ``_root_agent_is_workflow()`` predicate that gates the
    #1534 pre-append workaround for ag-ui#1669."""

    def test_llm_agent_root_is_not_workflow(self) -> None:
        """LlmAgent roots must take the pre-append path (ag-ui#1534)."""
        root_agent = Agent(
            name="llm_root",
            instruction="i am llm",
        )
        adk_agent = ADKAgent(
            adk_agent=root_agent,
            app_name="t",
            user_id="u",
            use_in_memory_services=True,
        )
        assert adk_agent._root_agent_is_workflow() is False

    def test_no_root_agent_returns_false(self) -> None:
        """Defensive: a missing root agent returns False rather than
        raising — the run will fail later in a clearer place."""
        # Construct an ADKAgent with an LlmAgent root, then strip the
        # internal reference to simulate no root.
        adk_agent = ADKAgent(
            adk_agent=Agent(name="r", instruction="r"),
            app_name="t",
            user_id="u",
            use_in_memory_services=True,
        )
        adk_agent._adk_agent = None
        adk_agent._app = None
        assert adk_agent._root_agent_is_workflow() is False

    def test_workflow_root_returns_true_when_available(self) -> None:
        """ADK 2.0 Workflow root → predicate returns True.

        Skips cleanly on ADK 1.x via the ImportError gate. The False branch
        for 1.x is covered by ``test_llm_agent_root_is_not_workflow``.
        """
        try:
            from google.adk.workflow import Workflow  # type: ignore[import-not-found]
        except ImportError:
            pytest.skip("Workflow not available on this ADK version (1.x)")

        # ``Workflow`` is a Pydantic v2 model; ``__new__`` + attribute
        # assignment raises AttributeError on ``__pydantic_fields_set__``.
        # Use the public constructor — ``name`` is the only required field.
        wf = Workflow(name="wf_root")

        adk_agent = ADKAgent(
            adk_agent=Agent(name="placeholder", instruction="p"),
            app_name="t",
            user_id="u",
            use_in_memory_services=True,
        )
        adk_agent._adk_agent = wf
        assert adk_agent._root_agent_is_workflow() is True


# ---------------------------------------------------------------------------
# ag-ui#1669 — End-to-end: Workflow root HITL resume carries FunctionResponse
#              in ``new_message`` (NOT an empty placeholder)
# ---------------------------------------------------------------------------


def _build_function_call_event(*, tool_call_id: str, tool_name: str, tool_args: dict):
    """Build an ADK session Event with a single function_call part.

    Seeds the session so the HITL FunctionResponse can be paired with a
    matching function_call (as a real paused Runner would have left it).
    """
    from google.adk.events import Event

    return Event(
        timestamp=time.time(),
        author="wf_root",
        invocation_id="inv_seed",
        content=types.Content(
            role="model",
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id=tool_call_id,
                        name=tool_name,
                        args=tool_args,
                    )
                )
            ],
        ),
    )


def _extract_function_response_ids(content) -> List[str]:
    """Return the IDs of every ``function_response`` part in a Content."""
    if content is None or not getattr(content, "parts", None):
        return []
    ids = []
    for part in content.parts:
        fr = getattr(part, "function_response", None)
        if fr is not None and getattr(fr, "id", None):
            ids.append(fr.id)
    return ids


def _is_empty_text_placeholder(content) -> bool:
    """True if ``content`` is the #1534 ``Part(text='')`` placeholder."""
    if content is None or not getattr(content, "parts", None):
        return False
    if len(content.parts) != 1:
        return False
    only_part = content.parts[0]
    return (
        getattr(only_part, "text", None) == ""
        and getattr(only_part, "function_call", None) is None
        and getattr(only_part, "function_response", None) is None
    )


class TestWorkflowRootHitlEndToEnd:
    """End-to-end regression for ag-ui#1669.

    Captures the ``new_message`` kwarg passed to ``runner.run_async`` on a
    HITL tool-result resume and asserts it carries the function_response
    (the input ``Workflow._extract_resume_inputs`` reads to rehydrate). A
    paired negative-control asserts LlmAgent roots still receive the
    #1534 empty-text placeholder, pinning the gate's discrimination.
    """

    @pytest.fixture(autouse=True)
    def _reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def workflow_app(self):
        try:
            from google.adk.workflow import Workflow  # type: ignore[import-not-found]
        except ImportError:
            pytest.skip("Workflow not available on this ADK version (1.x)")

        from google.adk.apps import App, ResumabilityConfig

        return App(
            name="wf_app",
            root_agent=Workflow(name="wf_root"),
            resumability_config=ResumabilityConfig(is_resumable=True),
        )

    @pytest.fixture
    def llm_app(self):
        from google.adk.apps import App, ResumabilityConfig

        return App(
            name="llm_app",
            root_agent=Agent(name="llm_root", instruction="i am llm"),
            resumability_config=ResumabilityConfig(is_resumable=True),
        )

    @staticmethod
    def _build_hitl_run_input(
        *, thread_id: str, run_id: str, tool_call_id: str, tool_name: str
    ) -> RunAgentInput:
        """RunAgentInput for a HITL resume: user msg, assistant tool_call,
        tool result. No trailing user — routes to the tool-result-only
        branch where the #1669 gate lives."""
        return RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            messages=[
                UserMessage(id="u1", role="user", content="kick off"),
                AssistantMessage(
                    id="a1",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            function=FunctionCall(
                                name=tool_name,
                                arguments='{"prompt": "pick one"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(
                    id="t1",
                    role="tool",
                    content='{"choice": "frozen"}',
                    tool_call_id=tool_call_id,
                ),
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

    @staticmethod
    async def _seed_pause_state(
        adk_agent: ADKAgent,
        *,
        app_name: str,
        thread_id: str,
        tool_call_id: str,
        tool_name: str,
        already_processed_message_ids: List[str],
    ):
        """Seed a paused HITL state: pending tool-call, function_call
        session event, and prior messages marked processed (so the
        middleware routes to the tool-result-only branch, not
        tool_results+user_message)."""
        session, _ = await adk_agent._ensure_session_exists(
            app_name=app_name,
            user_id="test_user",
            thread_id=thread_id,
            initial_state={},
        )
        await adk_agent._add_pending_tool_call_with_context(
            thread_id, tool_call_id, app_name, "test_user"
        )
        adk_agent._session_manager.mark_messages_processed(
            app_name, thread_id, already_processed_message_ids
        )
        await adk_agent._session_manager._session_service.append_event(
            session,
            _build_function_call_event(
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                tool_args={"prompt": "pick one"},
            ),
        )

    @pytest.mark.asyncio
    async def test_workflow_root_receives_function_response_in_new_message(
        self, workflow_app
    ):
        """Workflow root: ``new_message`` carries the function_response
        (not the #1534 empty-text placeholder)."""
        adk_agent = ADKAgent.from_app(
            workflow_app,
            user_id="test_user",
            use_in_memory_services=True,
        )

        thread_id = "wf_thread"
        tool_call_id = "wf_tool_call_1"
        tool_name = "adk_request_input"

        await self._seed_pause_state(
            adk_agent,
            app_name=workflow_app.name,
            thread_id=thread_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            already_processed_message_ids=["u1", "a1"],
        )

        captured = {}

        class CapturingRunner:
            async def run_async(self, **kwargs):
                if "new_message" not in captured:
                    captured["new_message"] = kwargs.get("new_message")
                return
                yield  # pragma: no cover

        run_input = self._build_hitl_run_input(
            thread_id=thread_id,
            run_id="run_resume",
            tool_call_id=tool_call_id,
            tool_name=tool_name,
        )
        tool_results = [{"tool_name": tool_name, "message": run_input.messages[2]}]

        with patch.object(adk_agent, "_create_runner", return_value=CapturingRunner()):
            await adk_agent._run_adk_in_background(
                input=run_input,
                adk_agent=adk_agent._adk_agent,
                user_id="test_user",
                app_name=workflow_app.name,
                event_queue=asyncio.Queue(),
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=None,
            )

        assert "new_message" in captured, "runner.run_async was never invoked"
        new_message = captured["new_message"]
        assert new_message is not None
        assert not _is_empty_text_placeholder(new_message), (
            f"Workflow root received #1534 placeholder; got {new_message!r}"
        )
        assert tool_call_id in _extract_function_response_ids(new_message)

    @pytest.mark.asyncio
    async def test_llm_root_still_receives_empty_placeholder(self, llm_app):
        """Negative control: LlmAgent root keeps the #1534 placeholder
        path. Catches accidental widening of the #1669 carve-out."""
        from ag_ui_adk.adk_agent import _ADK_OVERRIDES_INVOCATION_ID

        if not _ADK_OVERRIDES_INVOCATION_ID:
            pytest.skip("ADK build lacks Runner._resolve_invocation_id")

        adk_agent = ADKAgent.from_app(
            llm_app,
            user_id="test_user",
            use_in_memory_services=True,
        )

        thread_id = "llm_thread"
        tool_call_id = "llm_tool_call_1"
        tool_name = "approve_action"

        await self._seed_pause_state(
            adk_agent,
            app_name=llm_app.name,
            thread_id=thread_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            already_processed_message_ids=["u1", "a1"],
        )

        captured = {}

        class CapturingRunner:
            async def run_async(self, **kwargs):
                if "new_message" not in captured:
                    captured["new_message"] = kwargs.get("new_message")
                return
                yield  # pragma: no cover

        run_input = self._build_hitl_run_input(
            thread_id=thread_id,
            run_id="run_resume",
            tool_call_id=tool_call_id,
            tool_name=tool_name,
        )
        tool_results = [{"tool_name": tool_name, "message": run_input.messages[2]}]

        with patch.object(adk_agent, "_create_runner", return_value=CapturingRunner()):
            await adk_agent._run_adk_in_background(
                input=run_input,
                adk_agent=adk_agent._adk_agent,
                user_id="test_user",
                app_name=llm_app.name,
                event_queue=asyncio.Queue(),
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=None,
            )

        assert "new_message" in captured
        new_message = captured["new_message"]
        assert _is_empty_text_placeholder(new_message), (
            f"LlmAgent root must keep the #1534 placeholder; got {new_message!r}"
        )
        assert _extract_function_response_ids(new_message) == []
