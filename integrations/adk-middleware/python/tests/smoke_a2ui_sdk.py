"""Fresh-install CI smoke for the framework-independent A2UI SDK path.

Run with ``python -I tests/smoke_a2ui_sdk.py`` in an isolated environment
containing the built adapter and published SDK/Google dependencies, not pytest.
"""

import json
import sys
from importlib.metadata import distribution, version
from pathlib import Path

from a2ui.core import Catalog
from a2ui.inference_formats.express import ExpressFormatFactory

import ag_ui_adk
from ag_ui_adk import get_a2ui_tool
from ag_ui_adk.a2ui_google_sdk import heal_json_arg, render_catalog_instructions


def main() -> None:
    # uv can load wheels directly from its archive cache, outside sys.prefix.
    installed_module = distribution("ag-ui-adk").locate_file("ag_ui_adk/__init__.py")
    assert Path(ag_ui_adk.__file__).resolve() == Path(str(installed_module)).resolve()
    assert callable(get_a2ui_tool)
    for package in ("a2ui-agent-sdk", "a2ui-core", "google-adk", "google-genai"):
        print(package, version(package))

    for protocol in ("0.8", "0.9"):
        properties = {"label": {"type": "string"}}
        if protocol == "0.9":
            properties["binding"] = {"$ref": "common_types.json#/$defs/DynamicString"}
        client_catalog = {
            "catalogId": "cat://ci-client",
            "protocolVersion": protocol,
            "components": {"ClientCard": {"type": "object", "properties": properties}},
        }
        prompt = render_catalog_instructions(client_catalog, default_catalog_id=None)
        # Markers and versioned schema content distinguish the real SDK path
        # from the helper's intentional raw-catalog fallback.
        assert prompt is not None
        assert "---BEGIN A2UI JSON SCHEMA---" in prompt
        assert "ClientCard" in prompt and "cat://ci-client" in prompt
        assert "<a2ui-json>" not in prompt
        expected_message = "surfaceUpdate" if protocol == "0.8" else "updateComponents"
        assert expected_message in prompt
        if protocol == "0.9":
            common = json.loads(
                prompt.split("### Common Types Schema:\n", 1)[1].split(
                    "### Catalog Schema:", 1
                )[0]
            )
            assert {"DynamicString", "DataBinding"} <= common["$defs"].keys()

    # Express consumers can use the same environment as the adapter (v0.9).
    express = ExpressFormatFactory().create_format(
        catalogs=[Catalog.from_json(client_catalog)]
    )
    assert express.create_parser().compile('root = ClientCard(label="Hello")')
    assert heal_json_arg("[{“id”:“root”,}]", expect="list") == [{"id": "root"}]
    assert heal_json_arg("{“label”:“Hello”,}", expect="dict") == {"label": "Hello"}
    assert not any(
        name == "a2a" or name.startswith(("a2a.", "a2ui.adk", "a2ui.a2a"))
        for name in sys.modules
    )
    print("Installed adapter imports, SDK prompts, Express and JSON repair passed")


if __name__ == "__main__":
    main()
