"""Regression tests for https://github.com/ag-ui-protocol/ag-ui/issues/2013.

`fastapi` is an optional extra of `ag-ui-langgraph`. Importing the package —
or any submodule that does not serve HTTP — must never require it. Only
touching `add_langgraph_fastapi_endpoint` may raise ModuleNotFoundError.
"""

import subprocess
import sys
import unittest

SIMULATE_MISSING_FASTAPI = (
    "import sys; "
    "sys.modules['fastapi'] = None; "
    "sys.modules['fastapi.responses'] = None; "
)


class TestLazyFastApiExtra(unittest.TestCase):
    """FastAPI must stay optional (verified in isolated subprocesses)."""

    def run_isolated(self, snippet: str) -> "subprocess.CompletedProcess[str]":
        return subprocess.run(
            [sys.executable, "-c", SIMULATE_MISSING_FASTAPI + snippet],
            capture_output=True,
            text=True,
            timeout=120,
        )

    def test_package_import_without_fastapi(self):
        """`import ag_ui_langgraph` works on a default install."""
        proc = self.run_isolated("import ag_ui_langgraph; print('ok')")
        self.assertEqual(proc.returncode, 0, msg=proc.stderr[-2000:])
        self.assertIn("ok", proc.stdout)

    def test_middleware_import_without_fastapi(self):
        """The exact import from the issue works without the extra."""
        proc = self.run_isolated(
            "from ag_ui_langgraph.middlewares.state_streaming "
            "import StateStreamingMiddleware; print('ok')"
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr[-2000:])
        self.assertIn("ok", proc.stdout)

    def test_helper_advertised_but_requires_extra(self):
        """Helper stays public, but touching it needs fastapi installed."""
        proc = self.run_isolated(
            "import ag_ui_langgraph\n"
            "assert 'add_langgraph_fastapi_endpoint' in dir(ag_ui_langgraph)\n"
            "try:\n"
            "    ag_ui_langgraph.add_langgraph_fastapi_endpoint\n"
            "except ModuleNotFoundError:\n"
            "    print('ok')\n"
            "else:\n"
            "    raise SystemExit('helper did not require fastapi')"
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr[-2000:])
        self.assertIn("ok", proc.stdout)

    def test_helper_importable_with_fastapi(self):
        """With the extra installed, the public import path is unchanged."""
        pytest = None
        try:
            import pytest as _pytest  # noqa: F401

            pytest = _pytest
        except ImportError:
            pass
        if pytest is not None:
            pytest.importorskip("fastapi")
        else:
            try:
                import fastapi  # noqa: F401
            except ImportError:
                self.skipTest("fastapi extra not installed")

        from ag_ui_langgraph import add_langgraph_fastapi_endpoint

        self.assertTrue(callable(add_langgraph_fastapi_endpoint))


if __name__ == "__main__":
    unittest.main()
