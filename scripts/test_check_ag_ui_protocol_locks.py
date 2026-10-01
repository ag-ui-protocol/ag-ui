"""Unit tests for scripts/check-ag-ui-protocol-locks.py.

Run: python3 -m unittest discover -s scripts -p 'test_check_ag_ui_protocol_locks.py'
"""

import importlib.util
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "check_locks", Path(__file__).with_name("check-ag-ui-protocol-locks.py")
)
check_locks = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_locks)


def lock(*versions: str, name: str = "ag-ui-protocol") -> str:
    entries = [
        f'[[package]]\nname = "{name}"\nversion = "{version}"\n'
        for version in versions
    ]
    entries.append('[[package]]\nname = "fastapi"\nversion = "0.115.0"\n')
    return "\n".join(entries)


EXAMPLE = "integrations/foo/python/examples/uv.lock"


class InScopeTest(unittest.TestCase):
    def test_example_and_extra_locks_are_in_scope(self):
        self.assertTrue(check_locks.in_scope(EXAMPLE))
        self.assertTrue(check_locks.in_scope("middlewares/bar/examples/poetry.lock"))
        self.assertTrue(check_locks.in_scope("integrations/agent-spec/python/uv.lock"))

    def test_package_and_sdk_locks_are_out_of_scope(self):
        self.assertFalse(check_locks.in_scope("integrations/foo/python/uv.lock"))
        self.assertFalse(check_locks.in_scope("sdks/python/uv.lock"))
        self.assertFalse(check_locks.in_scope("integrations/foo/examples/package.lock"))


class CheckTest(unittest.TestCase):
    def test_1_0_lock_passes(self):
        self.assertEqual(check_locks.check({EXAMPLE: lock("1.0.0")}, {}), ([], []))

    def test_pre_1_0_lock_fails_without_exception(self):
        errors, _ = check_locks.check({EXAMPLE: lock("0.1.19")}, {})
        self.assertEqual(len(errors), 1)
        self.assertIn("0.1.19", errors[0])

    def test_any_pre_1_0_resolution_fails(self):
        errors, _ = check_locks.check({EXAMPLE: lock("1.0.0", "0.1.22")}, {})
        self.assertEqual(len(errors), 1)

    def test_package_name_is_normalized(self):
        errors, _ = check_locks.check({EXAMPLE: lock("0.1.10", name="ag_ui_protocol")}, {})
        self.assertEqual(len(errors), 1)

    def test_exception_allows_pre_1_0(self):
        self.assertEqual(
            check_locks.check({EXAMPLE: lock("0.1.19")}, {EXAMPLE: "PNI-1 reason"}),
            ([], []),
        )

    def test_stale_exception_only_warns(self):
        errors, warnings = check_locks.check(
            {EXAMPLE: lock("1.0.0")},
            {EXAMPLE: "PNI-1", "integrations/gone/examples/uv.lock": "PNI-2"},
        )
        self.assertEqual(errors, [])
        self.assertEqual(len(warnings), 2)

    def test_lock_without_package_passes(self):
        self.assertEqual(check_locks.check({EXAMPLE: lock(name="other")}, {}), ([], []))


class ParseExceptionsTest(unittest.TestCase):
    def test_parses_entries_and_ignores_comments(self):
        self.assertEqual(
            check_locks.parse_exceptions(f"# header\n\n{EXAMPLE}  # PNI-1 why\n"),
            {EXAMPLE: "PNI-1 why"},
        )

    def test_entry_requires_reason(self):
        with self.assertRaises(ValueError):
            check_locks.parse_exceptions(f"{EXAMPLE}\n")

    def test_duplicate_entry_rejected(self):
        with self.assertRaises(ValueError):
            check_locks.parse_exceptions(f"{EXAMPLE} # a\n{EXAMPLE} # b\n")


if __name__ == "__main__":
    unittest.main()
