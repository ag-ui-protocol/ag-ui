"""JSON config loader with environment variable resolution."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

_ENV_VAR_PATTERN = re.compile(r"\$\{([^}]+)\}")

_DEFAULT_CONFIG_DIR_ENV = "OPENRESPONSES_CONFIG_DIR"
_DEFAULT_CONFIG_DIR = "./configs"


def _get_config_dir(config_dir: str | None = None) -> Path:
    """Return the resolved config directory path."""
    if config_dir is not None:
        return Path(config_dir)
    return Path(os.environ.get(_DEFAULT_CONFIG_DIR_ENV, _DEFAULT_CONFIG_DIR))


def resolve_env_vars(value: Any) -> Any:
    """Recursively replace ``${VAR}`` and ``${VAR:-default}`` in *value*.

    Args:
        value: A string, dict, list, or other JSON-compatible value.

    Returns:
        The value with all ``${…}`` placeholders replaced by environment
        variable values.

    Raises:
        ValueError: If an env var is referenced without a default and is
            not set in the environment.
    """
    if isinstance(value, str):
        def _replace(match: re.Match) -> str:
            expr = match.group(1)
            if ":-" in expr:
                var_name, default = expr.split(":-", 1)
                return os.environ.get(var_name, default)
            var_name = expr
            env_val = os.environ.get(var_name)
            if env_val is None:
                raise ValueError(
                    f"Environment variable '{var_name}' is required but not set"
                )
            return env_val

        return _ENV_VAR_PATTERN.sub(_replace, value)

    if isinstance(value, dict):
        return {k: resolve_env_vars(v) for k, v in value.items()}

    if isinstance(value, list):
        return [resolve_env_vars(item) for item in value]

    return value


def load_config(name: str, config_dir: str | None = None) -> dict[str, Any]:
    """Load a named JSON config and resolve environment variables.

    Args:
        name: Config name (filename stem, without ``.json``).
        config_dir: Directory containing config files.  Defaults to
            ``$OPENRESPONSES_CONFIG_DIR`` or ``./configs``.

    Returns:
        Parsed and env-resolved config dict.

    Raises:
        FileNotFoundError: If the config file does not exist.
        ValueError: If a required env var is missing.
    """
    path = _get_config_dir(config_dir) / f"{name}.json"
    if not path.is_file():
        raise FileNotFoundError(f"Config file not found: {path}")

    with open(path) as f:
        raw = json.load(f)

    return resolve_env_vars(raw)


def list_configs(config_dir: str | None = None) -> list[str]:
    """List available config names (filename stems).

    Args:
        config_dir: Directory containing config files.

    Returns:
        Sorted list of config names.
    """
    d = _get_config_dir(config_dir)
    if not d.is_dir():
        return []
    return sorted(p.stem for p in d.glob("*.json"))
