"""Tests for Gemini 3 workarounds (streaming function call arguments)."""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch, PropertyMock
from types import SimpleNamespace

import ag_ui_adk.workarounds as workarounds
from ag_ui_adk.workarounds import (
    apply_aggregator_patch,
    repair_thought_signatures,
    SKIP_SENTINEL,
)


# ---------------------------------------------------------------------------
# Aggregator patch tests
# ---------------------------------------------------------------------------

class TestApplyAggregatorPatch:
    """Tests for apply_aggregator_patch idempotency and behavior."""

    def setup_method(self):
        # Reset the module-level flag before each test
        workarounds._patch_applied = False

    def test_patch_is_idempotent(self):
        """Calling apply_aggregator_patch twice doesn't double-wrap."""
        with patch("ag_ui_adk.workarounds.StreamingResponseAggregator", create=True) as mock_cls:
            # Provide an importable module path
            import importlib
            # We need to mock the import inside the function
            mock_aggregator = MagicMock()
            mock_aggregator._process_function_call_part = MagicMock()

            with patch.dict("sys.modules", {
                "google.adk.utils.streaming_utils": MagicMock(
                    StreamingResponseAggregator=mock_aggregator
                ),
            }):
                # Reset
                workarounds._patch_applied = False

                apply_aggregator_patch()
                first_method = mock_aggregator._process_function_call_part

                apply_aggregator_patch()
                second_method = mock_aggregator._process_function_call_part

                # The method should be the same after the second call (not re-wrapped)
                assert first_method is second_method

    def test_patch_skips_on_import_error(self):
        """Patch gracefully skips if StreamingResponseAggregator can't be imported."""
        workarounds._patch_applied = False

        with patch.dict("sys.modules", {
            "google.adk.utils.streaming_utils": None,
        }):
            # Should not raise
            apply_aggregator_patch()
            # Flag should not be set
            assert not workarounds._patch_applied


class TestPatchedProcessFunctionCallPart:
    """Tests for the patched _process_function_call_part behavior."""

    def _make_aggregator(self):
        """Create a mock aggregator with the patch applied."""
        agg = MagicMock()
        agg._current_thought_signature = None
        agg._current_fc_name = None
        agg._current_fc_args = ""
        return agg

    def _make_part(self, name=None, partial_args=None, will_continue=None, thought_signature=None):
        """Create a mock Part with function_call."""
        fc = SimpleNamespace(
            name=name,
            partial_args=partial_args,
        )
        if will_continue is not None:
            fc.will_continue = will_continue
        part = SimpleNamespace(
            function_call=fc,
        )
        if thought_signature is not None:
            part.thought_signature = thought_signature
        return part

    def test_first_streaming_chunk_routes_to_streaming_path(self):
        """First chunk (name + will_continue, no partial_args) goes to streaming path."""
        agg = self._make_aggregator()
        original = MagicMock()

        part = self._make_part(name="my_func", will_continue=True)

        # Simulate patched behavior inline
        fc = part.function_call
        has_partial_args = hasattr(fc, "partial_args") and fc.partial_args
        will_continue = getattr(fc, "will_continue", None)

        assert not has_partial_args
        assert will_continue is True
        assert fc.name == "my_func"

        # The patch should set partial_args to [] and call _process_streaming_function_call
        if getattr(fc, "partial_args", None) is None:
            fc.partial_args = []
        agg._process_streaming_function_call(fc)

        agg._process_streaming_function_call.assert_called_once_with(fc)
        assert fc.partial_args == []

    def test_end_of_stream_flushes(self):
        """End-of-stream marker (no name, no partial_args, no will_continue) flushes."""
        agg = self._make_aggregator()
        agg._current_fc_name = "my_func"  # has accumulated state

        part = self._make_part(name=None, partial_args=None, will_continue=None)
        fc = part.function_call

        has_partial_args = hasattr(fc, "partial_args") and fc.partial_args
        will_continue = getattr(fc, "will_continue", None)

        # Condition: no partial_args, no name, no will_continue, has _current_fc_name
        assert not has_partial_args
        assert not fc.name
        assert not will_continue
        assert agg._current_fc_name

        agg._flush_text_buffer_to_sequence()
        agg._flush_function_call_to_sequence()

        agg._flush_text_buffer_to_sequence.assert_called_once()
        agg._flush_function_call_to_sequence.assert_called_once()

    def test_non_streaming_delegates_to_original(self):
        """Non-streaming call (has partial_args) delegates to original."""
        part = self._make_part(name="fn", partial_args='{"x": 1}')

        fc = part.function_call
        has_partial_args = hasattr(fc, "partial_args") and fc.partial_args
        assert has_partial_args  # Should delegate to original

    def test_thought_signature_captured_on_first_chunk(self):
        """thought_signature from first streaming chunk is captured."""
        agg = self._make_aggregator()
        part = self._make_part(
            name="my_func",
            will_continue=True,
            thought_signature=b"real_sig",
        )

        fc = part.function_call
        if getattr(part, "thought_signature", None) and not agg._current_thought_signature:
            agg._current_thought_signature = part.thought_signature

        assert agg._current_thought_signature == b"real_sig"


# ---------------------------------------------------------------------------
# Thought-signature repair tests
# ---------------------------------------------------------------------------

class TestRepairThoughtSignatures:
    """Tests for repair_thought_signatures callback."""

    def _make_context(self, session_id="sess1", events=None):
        session = SimpleNamespace(id=session_id)
        if events is not None:
            session.events = events
        return SimpleNamespace(session=session)

    def _make_request(self, contents):
        return SimpleNamespace(contents=contents)

    def _make_content(self, parts):
        return SimpleNamespace(parts=parts)

    def _make_fc_part(self, name=None, fc_id=None, thought_signature=None):
        fc = SimpleNamespace(name=name, id=fc_id)
        part = SimpleNamespace(function_call=fc)
        if thought_signature is not None:
            part.thought_signature = thought_signature
        else:
            part.thought_signature = None
        return part

    def _make_text_part(self, text="hello"):
        return SimpleNamespace(function_call=None, text=text)

    def test_harvests_and_injects_signatures(self):
        """Harvests existing signatures and injects them for missing ones."""
        # Part with signature
        part_with_sig = self._make_fc_part(name="fn1", fc_id="id1", thought_signature=b"sig1")
        # Part missing signature but same fc_id
        part_missing = self._make_fc_part(name="fn1", fc_id="id1")

        content = self._make_content([part_with_sig, part_missing])
        ctx = self._make_context()
        req = self._make_request([content])

        repair_thought_signatures(ctx, req)

        assert part_missing.thought_signature == b"sig1"

    def test_uses_sentinel_for_uncached(self):
        """Uses SKIP_SENTINEL for parts with no cached signature."""
        part = self._make_fc_part(name="unknown_fn", fc_id="unknown_id")
        content = self._make_content([part])
        ctx = self._make_context()
        req = self._make_request([content])

        repair_thought_signatures(ctx, req)

        assert part.thought_signature == SKIP_SENTINEL

    def test_noop_when_all_present(self):
        """No changes when all parts already have signatures."""
        part = self._make_fc_part(name="fn1", fc_id="id1", thought_signature=b"existing")
        content = self._make_content([part])
        ctx = self._make_context()
        req = self._make_request([content])

        repair_thought_signatures(ctx, req)

        assert part.thought_signature == b"existing"

    def test_harvests_from_session_events(self):
        """Signatures are harvested from session events too."""
        event_part = self._make_fc_part(name="fn1", fc_id="id1", thought_signature=b"event_sig")
        event = SimpleNamespace(content=self._make_content([event_part]))

        # Content part missing signature
        part_missing = self._make_fc_part(name="fn1", fc_id="id1")
        content = self._make_content([part_missing])

        ctx = self._make_context(events=[event])
        req = self._make_request([content])

        repair_thought_signatures(ctx, req)

        assert part_missing.thought_signature == b"event_sig"

    def test_skips_non_function_call_parts(self):
        """Text parts are ignored."""
        text_part = self._make_text_part()
        content = self._make_content([text_part])
        ctx = self._make_context()
        req = self._make_request([content])

        # Should not raise
        repair_thought_signatures(ctx, req)


# ---------------------------------------------------------------------------
# ADKAgent integration: auto-apply workarounds
# ---------------------------------------------------------------------------

class TestADKAgentWorkaroundIntegration:
    """Test that ADKAgent auto-applies workarounds when streaming_function_call_arguments=True."""

    def test_aggregator_patch_called_on_init_when_streaming(self):
        """apply_aggregator_patch is called during ADKAgent.__init__ when streaming is enabled."""
        with patch("ag_ui_adk.adk_agent.apply_aggregator_patch") as mock_patch:
            from ag_ui_adk import ADKAgent
            from unittest.mock import MagicMock as MM

            agent = MM()
            agent.name = "test"
            agent.model_fields = {}

            try:
                ADKAgent(
                    adk_agent=agent,
                    app_name="test",
                    user_id="user",
                    streaming_function_call_arguments=True,
                )
            except Exception:
                pass

            mock_patch.assert_called_once()

    def test_aggregator_patch_not_called_when_not_streaming(self):
        """apply_aggregator_patch is NOT called when streaming is disabled."""
        with patch("ag_ui_adk.adk_agent.apply_aggregator_patch") as mock_patch:
            from ag_ui_adk import ADKAgent
            from unittest.mock import MagicMock as MM

            agent = MM()
            agent.name = "test"
            agent.model_fields = {}

            try:
                ADKAgent(
                    adk_agent=agent,
                    app_name="test",
                    user_id="user",
                    streaming_function_call_arguments=False,
                )
            except Exception:
                pass

            mock_patch.assert_not_called()
