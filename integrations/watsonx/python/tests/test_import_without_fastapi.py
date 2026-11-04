"""WatsonxAgent must import without the optional FastAPI extra."""

import sys


def test_importing_watsonx_agent_does_not_import_endpoint():
    for key in list(sys.modules):
        if key == "ag_ui_watsonx" or key.startswith("ag_ui_watsonx."):
            del sys.modules[key]

    import ag_ui_watsonx
    from ag_ui_watsonx import WatsonxAgent

    assert WatsonxAgent is ag_ui_watsonx.WatsonxAgent
    assert "ag_ui_watsonx.endpoint" not in sys.modules
