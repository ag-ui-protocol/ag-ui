"""ag_ui_langgraph must import without FastAPI installed (gh #2067).

FastAPI is an optional dependency (only the HTTP endpoint helper in endpoint.py
uses it), but __init__.py eagerly imported .endpoint, so `import ag_ui_langgraph`
/ `from ag_ui_langgraph import LangGraphAgent` raised ModuleNotFoundError when
FastAPI wasn't installed — breaking every purely in-process consumer that just
iterates LangGraphAgent.run() to render AG-UI events locally.
"""

import subprocess
import sys
import textwrap
import unittest


def _run_isolated(script: str) -> subprocess.CompletedProcess:
    """Run ``script`` in a fresh interpreter (this venv's python).

    Masking ``fastapi`` in ``sys.modules`` and re-importing ``ag_ui_langgraph``
    would leak into the rest of the suite (which relies on FastAPI for the
    endpoint tests), so each scenario gets its own subprocess.
    """
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        capture_output=True,
        text=True,
        timeout=120,
    )


# Setting a sys.modules entry to None makes the import system raise
# ModuleNotFoundError(name="fastapi") for `import fastapi`, exactly as if the
# package were not installed.
_FASTAPI_ABSENT_SCRIPT = """
    import sys
    sys.modules["fastapi"] = None

    import ag_ui_langgraph
    from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint

    # The helper must be importable and must fail only when called, using the
    # keyword form every real call site uses.
    try:
        add_langgraph_fastapi_endpoint(app=object(), agent=object(), path="/agent")
    except ModuleNotFoundError as ex:
        assert ex.name == "fastapi", f"unexpected missing module: {ex.name!r}"
        assert "ag-ui-langgraph[fastapi]" in str(ex), f"no install hint in: {ex}"
    else:
        raise SystemExit("add_langgraph_fastapi_endpoint should raise when FastAPI is absent")

    # Unknown names must still fail the normal way through the module __getattr__.
    try:
        from ag_ui_langgraph import something_totally_made_up
    except ImportError:
        pass
    else:
        raise SystemExit("importing a made-up symbol should fail")

    try:
        ag_ui_langgraph.something_totally_made_up
    except AttributeError:
        pass
    else:
        raise SystemExit("referencing a made-up symbol should fail")

    print("OK")
"""

_FASTAPI_PRESENT_SCRIPT = """
    import fastapi  # noqa: F401  (sanity: the dev environment has FastAPI)

    import ag_ui_langgraph
    import ag_ui_langgraph.endpoint
    from ag_ui_langgraph import add_langgraph_fastapi_endpoint

    # With FastAPI available the package-level name must be the real helper,
    # not the fallback stub.
    assert add_langgraph_fastapi_endpoint is ag_ui_langgraph.endpoint.add_langgraph_fastapi_endpoint

    print("OK")
"""


class TestImportWithoutFastAPI(unittest.TestCase):
    def _assert_ok(self, result: subprocess.CompletedProcess, what: str) -> None:
        self.assertEqual(
            result.returncode,
            0,
            f"{what} failed:\n--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}",
        )
        self.assertIn("OK", result.stdout)

    def test_package_imports_when_fastapi_is_absent(self):
        self._assert_ok(
            _run_isolated(_FASTAPI_ABSENT_SCRIPT),
            "importing ag_ui_langgraph without FastAPI",
        )

    def test_endpoint_helper_is_real_when_fastapi_is_present(self):
        self._assert_ok(
            _run_isolated(_FASTAPI_PRESENT_SCRIPT),
            "importing ag_ui_langgraph with FastAPI",
        )


if __name__ == "__main__":
    unittest.main()
