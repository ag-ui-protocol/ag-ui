"""RUN_STARTED declares the AG-UI protocol version this adapter speaks.

A source scan makes sure no ``RunStartedEvent`` construction in the package
leaves ``protocol_version`` off. The Dojo protocolVersion check covers the
wire end to end.
"""

import ast
from pathlib import Path

import ag_ui_strands


def test_every_run_started_construction_declares_the_protocol_version():
    package = Path(ag_ui_strands.__file__).parent
    missing: list[str] = []
    found = 0
    for source in sorted(package.rglob("*.py")):
        tree = ast.parse(source.read_text(), filename=str(source))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "RunStartedEvent"
            ):
                found += 1
                if "protocol_version" not in {kw.arg for kw in node.keywords}:
                    missing.append(f"{source.name}:{node.lineno}")

    assert found > 0
    assert missing == []
