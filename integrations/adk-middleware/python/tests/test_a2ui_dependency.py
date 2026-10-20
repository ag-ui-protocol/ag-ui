"""Keep an installable A2UI toolset available to consumers (#3089)."""

from importlib.metadata import requires

import pytest
from packaging.requirements import Requirement


@pytest.mark.parametrize(
    ("version", "allowed"),
    [
        ("0.2.1", False),  # Missing the absolute common-types reference fix.
        ("0.2.2", True),
        ("0.2.2.post1", False),  # Require verification before any SDK update.
        ("0.2.3", False),  # Toolset import raises NameError: models.
        ("0.2.4", False),  # Same undefined annotation as 0.2.3.
        ("0.2.5", False),  # Require an explicit compatibility migration.
        ("0.3.0", False),
        ("0.9.0", False),  # No longer ships a2ui.adk.
    ],
)
def test_a2ui_requirement_pins_verified_release(version, allowed):
    requirements = [
        Requirement(value)
        for value in requires("ag-ui-adk")
        if Requirement(value).name == "a2ui-agent-sdk"
    ]
    assert len(requirements) == 1
    assert requirements[0].specifier.contains(version) is allowed
