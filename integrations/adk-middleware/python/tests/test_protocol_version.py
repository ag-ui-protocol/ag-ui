"""RUN_STARTED must declare the AG-UI protocol version the middleware speaks.

``ADKAgent`` builds RUN_STARTED in several places (the main execution path plus
synthesized empty terminal pairs). The main path is asserted at runtime in
test_adk_agent.py; this source check covers every construction site, including
those that are awkward to reach in a unit test and any future one.
"""

import ast
import inspect

from ag_ui_adk import adk_agent as adk_agent_module


def test_every_run_started_site_passes_protocol_version():
    tree = ast.parse(inspect.getsource(adk_agent_module))
    sites = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "RunStartedEvent"
    ]

    assert sites, "no RunStartedEvent construction found in adk_agent.py"
    missing = [
        node.lineno
        for node in sites
        if not any(
            kw.arg == "protocol_version"
            and isinstance(kw.value, ast.Name)
            and kw.value.id == "PROTOCOL_VERSION"
            for kw in node.keywords
        )
    ]
    assert not missing, f"RunStartedEvent without protocol_version=PROTOCOL_VERSION at lines {missing}"
