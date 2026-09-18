import runpy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.mark.parametrize("scenario", ["success", "subagent"])
@pytest.mark.parametrize("override", [None, "explicit-model"])
async def test_capability_probe_preserves_default_and_explicit_model_configuration(
    monkeypatch, scenario, override,
):
    if override is None:
        monkeypatch.delenv("COPILOT_MODEL", raising=False)
    else:
        monkeypatch.setenv("COPILOT_MODEL", override)
    path = Path(__file__).resolve().parents[1] / "probes" / "native_capabilities.py"
    probe = runpy.run_path(str(path))["probe"]
    create = AsyncMock(side_effect=RuntimeError("Captured configuration; no native runtime"))
    with pytest.raises(RuntimeError, match="Captured configuration"):
        await probe(SimpleNamespace(create_session=create), scenario)
    options = create.await_args.kwargs
    assert options["model"] == (override or "auto")
    if scenario == "subagent":
        assert options["custom_agents"][0]["model"] == (override or "gpt-5.4-mini")
