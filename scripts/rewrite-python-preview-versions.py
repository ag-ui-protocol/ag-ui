#!/usr/bin/env python3
"""
Rewrites pyproject.toml files in-place for preview publishing to TestPyPI.

Usage:
    python scripts/rewrite-python-preview-versions.py 0.0.0.dev1741617123

For each package in PACKAGES:
  - Rewrites the package version to the given preview version
  - Rewrites any ag-ui-protocol dependency to pin the exact same preview
    version (so TestPyPI resolution finds the preview SDK, not a real one)

Handles all three build backends used in this repo:
  - uv_build / hatchling : version at [project].version,
                           deps at [project].dependencies (PEP 508 list)
  - poetry-core          : version at [tool.poetry].version,
                           deps at [tool.poetry.dependencies] (TOML table)
"""

import re
import sys
import tomllib
from pathlib import Path

# Ordered: ag-ui-protocol (no internal deps) first.
PACKAGES = [
    "sdks/python",
    "integrations/langgraph/python",
    "integrations/crew-ai/python",
    "integrations/agent-spec/python",
    "integrations/adk-middleware/python",
    "integrations/aws-strands/python",
]

SDK_PACKAGE_NAME = "ag-ui-protocol"


def _rewrite_key_in_section(text: str, section_re: str, key: str, value: str) -> str:
    """
    Replace the first `key = "..."` that appears after the section header
    matched by section_re and before the next section header.
    """
    pattern = re.compile(
        r"(?ms)"
        r"(" + section_re + r"[^\[]*?)"
        r"(" + re.escape(key) + r'\s*=\s*)"[^"]*"',
    )
    return pattern.sub(rf'\1\2"{value}"', text, count=1)


def rewrite_file(path: Path, new_version: str) -> None:
    original = path.read_text(encoding="utf-8")
    with path.open("rb") as f:
        data = tomllib.load(f)

    text = original
    build_backend = data.get("build-system", {}).get("build-backend", "")

    if build_backend == "poetry.core.masonry.api":
        # poetry-core: version in [tool.poetry], deps in [tool.poetry.dependencies]
        text = _rewrite_key_in_section(text, r"\[tool\.poetry\]", "version", new_version)

        # ag-ui-protocol = ">=0.1.10"  ->  ag-ui-protocol = "==0.0.0.devN"
        text = re.sub(
            r'(?m)^(ag-ui-protocol\s*=\s*)"[^"]*"',
            rf'\1"=={new_version}"',
            text,
        )
    else:
        # uv_build / hatchling: version in [project], deps in [project].dependencies
        text = _rewrite_key_in_section(text, r"\[project\]", "version", new_version)

        # "ag-ui-protocol>=0.1.10"  ->  "ag-ui-protocol==0.0.0.devN"
        # Require a version specifier after the name (>=, >, ==, etc.)
        # to avoid matching the package's own name field.
        text = re.sub(
            r'("ag-ui-protocol)[><=!~][^"]*(")',
            rf"\g<1>=={new_version}\2",
            text,
        )

    if text == original:
        print(f"  WARNING: no changes made to {path}")

    path.write_text(text, encoding="utf-8")


def verify_version(path: Path, new_version: str) -> None:
    """Re-parse the file and assert the version was written correctly."""
    with path.open("rb") as f:
        data = tomllib.load(f)

    build_backend = data.get("build-system", {}).get("build-backend", "")
    if build_backend == "poetry.core.masonry.api":
        got = data["tool"]["poetry"]["version"]
    else:
        got = data["project"]["version"]

    if got != new_version:
        print(
            f"  ERROR: version verification failed for {path}: "
            f"expected {new_version!r}, got {got!r}",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"    verified: {got}")


def main() -> None:
    if len(sys.argv) != 2:
        print(
            "Usage: rewrite-python-preview-versions.py <version>",
            file=sys.stderr,
        )
        sys.exit(1)

    new_version = sys.argv[1]
    repo_root = Path(__file__).resolve().parent.parent

    print(f"Rewriting all packages to version: {new_version}")
    for pkg_rel in PACKAGES:
        toml_path = repo_root / pkg_rel / "pyproject.toml"
        if not toml_path.exists():
            print(f"  ERROR: {toml_path} not found", file=sys.stderr)
            sys.exit(1)
        print(f"  {pkg_rel}/pyproject.toml")
        rewrite_file(toml_path, new_version)
        verify_version(toml_path, new_version)

    print("Done.")


if __name__ == "__main__":
    main()
