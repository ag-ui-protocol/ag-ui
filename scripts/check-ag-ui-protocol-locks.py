#!/usr/bin/env python3
"""Fail if a Dojo example Python lock resolves ag-ui-protocol < 1.0 (PNI-537).

The Dojo runs each Python example from its committed lock (uv.lock or
poetry.lock). This guard keeps those locks from silently falling back to the
0.x protocol line. Locks allowed to stay on 0.x for now are listed, with the
ticket that moves them, in scripts/ag-ui-protocol-lock-exceptions.txt.

In scope: every git-tracked uv.lock / poetry.lock under integrations/ or
middlewares/ that lives in an examples/ directory, plus EXTRA_LOCKS (Dojo
examples that resolve through their package's lock).

Exit status 1 lists each offending lock. Exception entries that are no longer
needed (the lock now resolves >= 1.0, or no longer exists) only warn, so an
integration PR that relocks to 1.0 is never blocked by this file.

Usage: python3 scripts/check-ag-ui-protocol-locks.py [--repo-root PATH]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tomllib
from pathlib import Path

PACKAGE = "ag-ui-protocol"
SCOPE_ROOTS = ("integrations/", "middlewares/")
LOCK_NAMES = ("uv.lock", "poetry.lock")
# Dojo examples with no lock of their own: the example's pyproject resolves
# through its package project's uv.lock.
EXTRA_LOCKS = frozenset({"integrations/agent-spec/python/uv.lock"})
EXCEPTIONS_FILE = "scripts/ag-ui-protocol-lock-exceptions.txt"


def normalize(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


def in_scope(path: str) -> bool:
    if path in EXTRA_LOCKS:
        return True
    return (
        path.startswith(SCOPE_ROOTS)
        and path.rsplit("/", 1)[-1] in LOCK_NAMES
        and "/examples/" in f"/{path}"
    )


def resolved_versions(lock_text: str) -> list[str]:
    """All versions of ag-ui-protocol a uv.lock / poetry.lock resolves."""
    data = tomllib.loads(lock_text)
    return [
        str(package.get("version", ""))
        for package in data.get("package", [])
        if normalize(str(package.get("name", ""))) == PACKAGE
    ]


def is_pre_1_0(version: str) -> bool:
    major = version.split(".", 1)[0]
    if not major.isdigit():
        raise ValueError(f"cannot parse {PACKAGE} version {version!r}")
    return int(major) < 1


def parse_exceptions(text: str) -> dict[str, str]:
    exceptions: dict[str, str] = {}
    for line_number, raw in enumerate(text.splitlines(), start=1):
        path, _, reason = raw.partition("#")
        path = path.strip()
        if not path:
            continue
        if path in exceptions:
            raise ValueError(f"{EXCEPTIONS_FILE}:{line_number}: duplicate entry {path}")
        if not reason.strip():
            raise ValueError(
                f"{EXCEPTIONS_FILE}:{line_number}: {path} needs a '# <ticket> reason' comment"
            )
        exceptions[path] = reason.strip()
    return exceptions


def tracked_locks(repo_root: Path) -> list[str]:
    output = subprocess.run(
        ["git", "ls-files", "-z", "--", *(f"*{name}" for name in LOCK_NAMES)],
        cwd=repo_root,
        check=True,
        capture_output=True,
    ).stdout.decode()
    return sorted(path for path in output.split("\0") if path)


def check(
    locks: dict[str, str], exceptions: dict[str, str]
) -> tuple[list[str], list[str]]:
    """Returns (errors, warnings) for {lock path: lock text} in scope."""
    errors: list[str] = []
    warnings: list[str] = []
    for path, text in sorted(locks.items()):
        try:
            versions = resolved_versions(text)
            old = sorted({v for v in versions if is_pre_1_0(v)})
        except (tomllib.TOMLDecodeError, ValueError) as error:
            errors.append(f"{path}: cannot read lock: {error}")
            continue
        if old and path not in exceptions:
            errors.append(
                f"{path}: resolves {PACKAGE} {', '.join(old)} (< 1.0). Relock on "
                f">= 1.0, or add it to {EXCEPTIONS_FILE} with a ticket reference."
            )
        elif not old and path in exceptions:
            warnings.append(
                f"{path}: no longer resolves {PACKAGE} < 1.0; remove its entry "
                f"from {EXCEPTIONS_FILE} ({exceptions[path]})."
            )
    for path, reason in sorted(exceptions.items()):
        if path not in locks:
            warnings.append(
                f"{EXCEPTIONS_FILE}: {path} is not a tracked Dojo example lock; "
                f"remove the entry ({reason})."
            )
    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--repo-root", type=Path, default=Path(__file__).resolve().parent.parent
    )
    args = parser.parse_args()
    root: Path = args.repo_root

    exceptions = parse_exceptions((root / EXCEPTIONS_FILE).read_text())
    locks = {
        path: (root / path).read_text()
        for path in tracked_locks(root)
        if in_scope(path)
    }
    errors, warnings = check(locks, exceptions)

    for warning in warnings:
        print(f"::warning file={EXCEPTIONS_FILE}::{warning}")
    for error in errors:
        print(f"::error::{error}")
    print(
        f"Checked {len(locks)} Dojo example lock(s); {len(exceptions)} exception(s); "
        f"{len(errors)} error(s), {len(warnings)} warning(s)."
    )
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
