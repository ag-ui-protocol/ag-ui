#!/usr/bin/env python3
"""Check enrolled JAR publications after an unsigned Maven release build."""

import argparse
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "reactors", nargs="+", type=Path, help="reactor POMs that were built"
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    config = json.loads((root / "scripts/release/release.config.json").read_text())
    requested = {pom.resolve() for pom in args.reactors}
    checked = set()
    errors = []
    count = 0

    for scope in config["scopes"].values():
        pom = (root / scope.get("versionSource", "")).resolve()
        packages = [pkg for pkg in scope["packages"] if pkg["ecosystem"] == "maven"]
        if pom not in requested or not packages:
            continue
        checked.add(pom)
        version = ET.parse(pom).getroot().findtext(
            "{http://maven.apache.org/POM/4.0.0}version"
        )
        if not version:
            errors.append(f"No project version in {pom.relative_to(root)}")
            continue
        for pkg in packages:
            count += 1
            for classifier in ("", "-sources", "-javadoc"):
                jar = (
                    root / pkg["path"] / "target"
                    / f"{pkg['name']}-{version}{classifier}.jar"
                )
                if not jar.is_file():
                    errors.append(f"Missing {jar.relative_to(root)}")
                    continue
                try:
                    with zipfile.ZipFile(jar) as archive:
                        if archive.testzip() is not None or not archive.namelist():
                            errors.append(f"Invalid archive {jar.relative_to(root)}")
                except zipfile.BadZipFile:
                    errors.append(f"Invalid archive {jar.relative_to(root)}")

    errors.extend(
        f"No Maven release scope for {pom}" for pom in sorted(requested - checked)
    )
    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
        return 1
    print(f"OK: {count} Maven artifacts have main, sources, and Javadoc archives")
    return 0


if __name__ == "__main__":
    sys.exit(main())
