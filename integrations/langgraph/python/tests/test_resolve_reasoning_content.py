"""Tests for resolve_reasoning_content covering all supported reasoning formats."""
from types import SimpleNamespace

from ag_ui_langgraph.utils import resolve_reasoning_content


def _chunk(content, **extra):
    """Build a minimal chunk-like object with .content and optional attrs."""
    ns = SimpleNamespace(content=content, **extra)
    return ns


# ── Bedrock Converse API ──────────────────────────────────────────────

class TestBedrockConverseReasoning:
    """Regression tests for issue #1361 – Bedrock Converse reasoning_content."""

    def test_bedrock_converse_basic(self):
        chunk = _chunk([{
            "type": "reasoning_content",
            "reasoning_content": {"text": "Let me think…"}
        }])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Let me think…"
        assert result["type"] == "text"
        assert result["index"] == 0

    def test_bedrock_converse_with_signature(self):
        chunk = _chunk([{
            "type": "reasoning_content",
            "reasoning_content": {"text": "Step 1…", "signature": "sig123"}
        }])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Step 1…"
        assert result["signature"] == "sig123"

    def test_bedrock_converse_with_index(self):
        chunk = _chunk([{
            "type": "reasoning_content",
            "reasoning_content": {"text": "Indexed"},
            "index": 3,
        }])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["index"] == 3

    def test_bedrock_converse_empty_text_returns_none(self):
        chunk = _chunk([{
            "type": "reasoning_content",
            "reasoning_content": {"text": ""}
        }])
        result = resolve_reasoning_content(chunk)
        assert result is None

    def test_bedrock_converse_missing_text_returns_none(self):
        chunk = _chunk([{
            "type": "reasoning_content",
            "reasoning_content": {"signature": "sig_only"}
        }])
        result = resolve_reasoning_content(chunk)
        assert result is None

    def test_bedrock_converse_non_dict_inner_returns_none(self):
        chunk = _chunk([{
            "type": "reasoning_content",
            "reasoning_content": "just a string"
        }])
        result = resolve_reasoning_content(chunk)
        assert result is None


# ── Existing formats (sanity checks) ─────────────────────────────────

class TestAnthropicThinkingFormat:
    def test_thinking_block(self):
        chunk = _chunk([{"type": "thinking", "thinking": "Deep thought"}])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Deep thought"
        assert result["type"] == "text"

    def test_thinking_with_signature(self):
        chunk = _chunk([{
            "type": "thinking",
            "thinking": "Thought",
            "signature": "abc",
        }])
        result = resolve_reasoning_content(chunk)
        assert result["signature"] == "abc"


class TestLangChainReasoningFormat:
    def test_reasoning_block(self):
        chunk = _chunk([{"type": "reasoning", "reasoning": "Reason text"}])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Reason text"


class TestOpenAIFormats:
    def test_openai_summary_format(self):
        chunk = _chunk([{
            "type": "reasoning",
            "summary": [{"text": "Summary text", "index": 1}],
        }])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Summary text"
        assert result["index"] == 1

    def test_openai_legacy_additional_kwargs(self):
        chunk = _chunk(
            None,
            additional_kwargs={"reasoning": {"summary": [{"text": "Legacy", "index": 2}]}},
        )
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Legacy"
        assert result["index"] == 2


class TestEdgeCases:
    def test_empty_content_no_kwargs_returns_none(self):
        chunk = _chunk(None)
        assert resolve_reasoning_content(chunk) is None

    def test_empty_list_returns_none(self):
        chunk = _chunk([])
        assert resolve_reasoning_content(chunk) is None
