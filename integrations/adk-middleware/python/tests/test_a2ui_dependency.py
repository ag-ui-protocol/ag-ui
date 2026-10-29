"""Require the migrated, framework-independent A2UI SDK APIs (#3121)."""

from importlib.metadata import requires

import pytest
from packaging.requirements import Requirement


@pytest.mark.parametrize(
    ("version", "allowed"),
    [
        ("0.2.1", False),  # Missing the absolute common-types reference fix.
        ("0.2.2", False),  # Legacy schema-manager APIs are no longer supported.
        ("0.2.3", False),  # Toolset import raises NameError: models.
        ("0.2.4", False),  # Same undefined annotation as 0.2.3.
        ("0.2.5", False),  # Require an explicit compatibility migration.
        ("0.3.0", False),
        ("0.9.0", True),
        ("0.9.1", True),
        ("0.10.0", False),
        ("1.0.0", False),
    ],
)
def test_a2ui_requirement_selects_migrated_api_range(version, allowed):
    requirements = [
        Requirement(value)
        for value in requires("ag-ui-adk")
        if Requirement(value).name == "a2ui-agent-sdk"
    ]
    assert len(requirements) == 1
    assert requirements[0].specifier.contains(version) is allowed


def test_a2ui_requires_core_without_framework_integration():
    requirements = {
        Requirement(value).name: Requirement(value) for value in requires("ag-ui-adk")
    }
    assert requirements["a2ui-core"].specifier.contains("0.4.0")
    assert not requirements["a2ui-core"].specifier.contains("0.5.0")
    assert "a2ui-adk" not in requirements
