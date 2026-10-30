#!/usr/bin/env python3
"""Reproduce the temporary, isolated A2UI streaming SDK snapshot.

Download the pinned upstream archive, or pass its extracted root with --source.
Only Python module namespace references are relocated; algorithms and resources
are otherwise unchanged. The manifest records both source and relocated hashes.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import urllib.request

REVISION = "f290f54b09d85509b5fa8e09b722b7282c776a65"
URL = f"https://github.com/a2ui-project/a2ui/archive/{REVISION}.tar.gz"
ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "integrations/adk-middleware/python/src/ag_ui_adk/_vendor"


def generate(source: Path) -> None:
    target = DEST / "a2ui"
    if target.exists():
        shutil.rmtree(target)
    manifest = {}
    for relative in ("python/a2ui_agent/src/a2ui", "python/a2ui_core/src/a2ui"):
        for path in sorted((source / relative).rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
                continue
            original = path.read_bytes()
            relocated = original
            if path.suffix == ".py":
                relocated_text = re.sub(
                    r"\ba2ui\.(?!org\b)", "ag_ui_adk._vendor.a2ui.", original.decode()
                )
                relocated = re.sub(
                    r"\bfrom a2ui import\b", "from ag_ui_adk._vendor.a2ui import", relocated_text
                ).encode()
            out = target / path.relative_to(source / relative)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(relocated)
            manifest[str(path.relative_to(source))] = {
                "source_sha256": hashlib.sha256(original).hexdigest(),
                "vendored_sha256": hashlib.sha256(relocated).hexdigest(),
                "destination": str(out.relative_to(DEST)),
            }
    shutil.copyfile(source / "LICENSE", DEST / "LICENSE.a2ui")
    (DEST / "manifest.json").write_text(
        json.dumps({"revision": REVISION, "files": manifest}, indent=2) + "\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    if args.source:
        generate(args.source)
        return
    with urllib.request.urlopen(URL) as response:
        archive = response.read()
    with tempfile.TemporaryDirectory() as directory:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as archive_file:
            archive_file.extractall(directory, filter="data")
        generate(next(Path(directory).iterdir()))


if __name__ == "__main__":
    main()
