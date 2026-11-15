"""Compatibility checks for the published SDK's incremental Express streaming."""

from __future__ import annotations

import pytest

from a2ui.core import A2uiParseError, Catalog
from a2ui.inference_formats.express import ExpressFormatFactory
from a2ui.parser import A2uiPart

CATALOG = {
    "catalogId": "cat://express-smoke",
    "components": {
        "Text": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        }
    },
}


def test_upstream_express_streams_and_rejects_truncation():
    catalog = Catalog.from_json(CATALOG)
    format = ExpressFormatFactory(surface_id="s", version="v0.9").create_format(
        [catalog]
    )
    parser = format.create_parser()
    assert format.supports_streaming and parser.supports_streaming
    stream = parser.open_stream()
    parts = stream.feed('<a2ui>\nroot = Text("Hel')
    assert any(isinstance(part, A2uiPart) for part in parts)
    assert (
        stream.state.get_surface("s").components_model.get("root").properties["text"]
        == "Hel"
    )
    stream.feed('lo")\n</a2ui>')
    assert stream.close() == []
    assert (
        stream.state.get_surface("s").components_model.get("root").properties["text"]
        == "Hello"
    )

    truncated = parser.open_stream()
    truncated.feed('<a2ui>\nroot = Text("Hello")\n')
    with pytest.raises(A2uiParseError, match="ended inside an <a2ui> block"):
        truncated.close()
