"""Tests for config_loader module."""

import json
import os
import pytest
from pathlib import Path
from unittest.mock import patch

from ag_ui_openresponses.config_loader import (
    list_configs,
    load_config,
    resolve_env_vars,
)


class TestResolveEnvVars:
    def test_simple_string_replacement(self):
        with patch.dict(os.environ, {"MY_KEY": "secret123"}):
            assert resolve_env_vars("${MY_KEY}") == "secret123"

    def test_embedded_replacement(self):
        with patch.dict(os.environ, {"HOST": "example.com"}):
            assert resolve_env_vars("https://${HOST}/api") == "https://example.com/api"

    def test_default_value_used_when_missing(self):
        env = {k: v for k, v in os.environ.items() if k != "UNSET_VAR"}
        with patch.dict(os.environ, env, clear=True):
            assert resolve_env_vars("${UNSET_VAR:-fallback}") == "fallback"

    def test_default_value_not_used_when_present(self):
        with patch.dict(os.environ, {"SET_VAR": "actual"}):
            assert resolve_env_vars("${SET_VAR:-fallback}") == "actual"

    def test_missing_required_var_raises(self):
        env = {k: v for k, v in os.environ.items() if k != "MISSING_VAR"}
        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(ValueError, match="MISSING_VAR"):
                resolve_env_vars("${MISSING_VAR}")

    def test_recursive_dict(self):
        with patch.dict(os.environ, {"A": "1", "B": "2"}):
            result = resolve_env_vars({"x": "${A}", "y": {"z": "${B}"}})
            assert result == {"x": "1", "y": {"z": "2"}}

    def test_recursive_list(self):
        with patch.dict(os.environ, {"V": "val"}):
            assert resolve_env_vars(["${V}", 42]) == ["val", 42]

    def test_non_string_passthrough(self):
        assert resolve_env_vars(42) == 42
        assert resolve_env_vars(True) is True
        assert resolve_env_vars(None) is None

    def test_empty_default(self):
        env = {k: v for k, v in os.environ.items() if k != "EMPTY_DEFAULT"}
        with patch.dict(os.environ, env, clear=True):
            assert resolve_env_vars("${EMPTY_DEFAULT:-}") == ""


class TestLoadConfig:
    def test_load_valid_config(self, tmp_path: Path):
        cfg = {"base_url": "https://api.openai.com/v1", "api_key": "${KEY}"}
        (tmp_path / "test.json").write_text(json.dumps(cfg))
        with patch.dict(os.environ, {"KEY": "sk-123"}):
            result = load_config("test", config_dir=str(tmp_path))
        assert result["api_key"] == "sk-123"
        assert result["base_url"] == "https://api.openai.com/v1"

    def test_file_not_found(self, tmp_path: Path):
        with pytest.raises(FileNotFoundError):
            load_config("nonexistent", config_dir=str(tmp_path))

    def test_missing_env_var_in_config(self, tmp_path: Path):
        cfg = {"api_key": "${TOTALLY_MISSING}"}
        (tmp_path / "bad.json").write_text(json.dumps(cfg))
        env = {k: v for k, v in os.environ.items() if k != "TOTALLY_MISSING"}
        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(ValueError, match="TOTALLY_MISSING"):
                load_config("bad", config_dir=str(tmp_path))


class TestListConfigs:
    def test_list_configs(self, tmp_path: Path):
        (tmp_path / "alpha.json").write_text("{}")
        (tmp_path / "beta.json").write_text("{}")
        (tmp_path / "not-json.txt").write_text("")
        result = list_configs(config_dir=str(tmp_path))
        assert result == ["alpha", "beta"]

    def test_empty_dir(self, tmp_path: Path):
        assert list_configs(config_dir=str(tmp_path)) == []

    def test_missing_dir(self):
        assert list_configs(config_dir="/nonexistent/path") == []


# ─────────────────────────────────────────────────────────────────────────────
# fill_runtime_config tests
# ─────────────────────────────────────────────────────────────────────────────

from ag_ui_openresponses.types import OpenResponsesAgentConfig, fill_runtime_config


class TestFillRuntimeConfig:
    def test_fills_empty_fields(self):
        base = OpenResponsesAgentConfig(base_url="https://api.openai.com/v1")
        result = fill_runtime_config(base, {"api_key": "sk-caller"})
        assert result.api_key == "sk-caller"

    def test_does_not_override_set_fields(self):
        base = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            api_key="sk-config",
        )
        result = fill_runtime_config(base, {"api_key": "sk-evil"})
        assert result.api_key == "sk-config"

    def test_fills_none_headers(self):
        base = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            api_key="sk-config",
        )
        assert base.headers is None
        result = fill_runtime_config(base, {"headers": {"X-Custom": "val"}})
        assert result.headers == {"X-Custom": "val"}

    def test_does_not_override_set_headers(self):
        base = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer x"},
        )
        result = fill_runtime_config(base, {"headers": {"X-Evil": "bad"}})
        assert result.headers == {"Authorization": "Bearer x"}

    def test_ignores_unknown_keys(self):
        base = OpenResponsesAgentConfig(base_url="https://api.openai.com/v1")
        result = fill_runtime_config(base, {"unknown_key": "value"})
        assert result.base_url == "https://api.openai.com/v1"

    def test_default_numeric_not_overridden(self):
        """timeout_seconds defaults to 120.0 — if unchanged, caller can fill it."""
        base = OpenResponsesAgentConfig(base_url="https://api.openai.com/v1")
        result = fill_runtime_config(base, {"timeout_seconds": 60.0})
        assert result.timeout_seconds == 60.0

    def test_changed_numeric_not_overridden(self):
        base = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1", timeout_seconds=30.0
        )
        result = fill_runtime_config(base, {"timeout_seconds": 60.0})
        assert result.timeout_seconds == 30.0


# ─────────────────────────────────────────────────────────────────────────────
# restrict_configs integration tests
# ─────────────────────────────────────────────────────────────────────────────

from unittest.mock import AsyncMock, MagicMock, patch as stdlib_patch
from ag_ui_openresponses.agent import OpenResponsesAgent
from ag_ui.core import RunAgentInput


class TestRestrictConfigs:
    def test_no_config_name_raises(self):
        agent = OpenResponsesAgent(restrict_configs=True)
        input_data = RunAgentInput(
            thread_id="t1",
            run_id="r1",
            messages=[],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )
        with pytest.raises(ValueError, match="named config is required"):
            agent._resolve_run_config(input_data)

    def test_config_name_accepted(self, tmp_path: Path):
        cfg = {"base_url": "https://api.openai.com/v1", "api_key": "sk-123"}
        (tmp_path / "myconfig.json").write_text(json.dumps(cfg))

        agent = OpenResponsesAgent(restrict_configs=True)
        input_data = RunAgentInput(
            thread_id="t1",
            run_id="r1",
            messages=[],
            tools=[],
            context=[],
            state={},
            forwarded_props={"config_name": "myconfig"},
        )
        with stdlib_patch(
            "ag_ui_openresponses.agent.load_config",
            side_effect=lambda name, **kw: cfg,
        ):
            http_client, rb = agent._resolve_run_config(input_data)
        assert http_client is not None

    def test_restrict_fills_gaps_not_overrides(self, tmp_path: Path):
        named_cfg = {
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-from-config",
        }

        agent = OpenResponsesAgent(restrict_configs=True)
        input_data = RunAgentInput(
            thread_id="t1",
            run_id="r1",
            messages=[],
            tools=[],
            context=[],
            state={},
            forwarded_props={
                "config_name": "myconfig",
                "openresponses_config": {
                    "api_key": "sk-evil",
                    "headers": {"X-Custom": "allowed"},
                },
            },
        )
        with stdlib_patch(
            "ag_ui_openresponses.agent.load_config",
            side_effect=lambda name, **kw: named_cfg,
        ):
            http_client, rb = agent._resolve_run_config(input_data)
        # api_key should be from the named config, not the caller
        assert rb._config.api_key == "sk-from-config"
        # headers should be filled from caller since named config didn't set them
        assert rb._config.headers == {"X-Custom": "allowed"}
