"""Compatibility checks for the temporary upstream streaming SDK snapshot."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from ag_ui_adk import _vendor
from ag_ui_adk._vendor.a2ui.core import A2uiParseError, Catalog
from ag_ui_adk._vendor.a2ui.inference_formats.express import ExpressFormatFactory
from ag_ui_adk._vendor.a2ui.parser import A2uiPart

CATALOG = {
    "catalogId": "cat://vendor-smoke",
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


def test_vendored_snapshot_hashes_match_recorded_provenance():
    root = Path(_vendor.__file__).parent
    manifest = json.loads((root / "manifest.json").read_text())
    assert manifest["revision"] == "f290f54b09d85509b5fa8e09b722b7282c776a65"
    for record in manifest["files"].values():
        assert (
            hashlib.sha256((root / record["destination"]).read_bytes()).hexdigest()
            == record["vendored_sha256"]
        )
    assert "Apache License" in (root / "LICENSE.a2ui").read_text()


def test_published_sdk_capability_is_checked_before_using_temporary_snapshot():
    from importlib.metadata import version
    from a2ui.core import Catalog as PublishedCatalog
    from a2ui.inference_formats.express import ExpressFormatFactory as PublishedFactory

    # The last release lacks PR #3712. A newer release that supports streaming
    # makes this test a reminder to remove the snapshot and raise the floor.
    published = PublishedFactory(version="v0.9").create_format(
        [PublishedCatalog.from_json(CATALOG)]
    )
    if version("a2ui-agent-sdk") == "0.9.0":
        assert published.supports_streaming is False
    assert Catalog is not PublishedCatalog


def test_vendored_modules_never_import_canonical_sdk_namespaces():
    import ast

    root = Path(_vendor.__file__).parent / "a2ui"
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom):
                assert node.module != "a2ui" and not (node.module or "").startswith(
                    "a2ui."
                ), str(path)
            elif isinstance(node, ast.Import):
                assert all(
                    alias.name != "a2ui" and not alias.name.startswith("a2ui.")
                    for alias in node.names
                ), str(path)
