"""Check whether crates.io already has this ag-ui runtime and manifest."""

import hashlib
import io
import json
import sys
import tarfile
import tomllib
from pathlib import Path
from urllib.request import Request, urlopen


def fetch(url):
    request = Request(url, headers={"User-Agent": "AG-UI Rust SDK release verification"})
    with urlopen(request, timeout=30) as response:
        return response.read()


def runtime(archive, version):
    """Compare the shipped code, build inputs, features, and runtime dependencies."""
    prefix = f"ag-ui-{version}/"
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        manifests = tomllib.loads(package.extractfile(prefix + "Cargo.toml").read().decode())
        files = {
            member.name[len(prefix):]: package.extractfile(member).read()
            for member in package.getmembers()
            if member.isfile() and member.name.startswith(prefix + "src/")
        }
        if not files:
            raise ValueError("ag-ui package has no runtime source")
        if prefix + "build.rs" in package.getnames():
            files["build.rs"] = package.extractfile(prefix + "build.rs").read()
    declarations = {
        key: manifests.get(key) for key in (
            "lib", "features", "dependencies", "build-dependencies", "target", "lints",
        )
    }
    declarations["package"] = {
        key: manifests["package"].get(key)
        for key in ("name", "version", "edition", "rust-version", "build", "links")
    }
    return files, declarations


def main():
    version, archive = sys.argv[1:]
    index = fetch("https://index.crates.io/ag/-u/ag-ui")
    releases = (json.loads(line) for line in index.splitlines())
    release = next((row for row in releases if row["vers"] == version), None)
    if release is None:
        print("false")
        return

    if release["yanked"]:
        sys.exit(f"ag-ui {version} is yanked; review the release version")
    published = fetch(f"https://static.crates.io/crates/ag-ui/ag-ui-{version}.crate")
    if hashlib.sha256(published).hexdigest() != release["cksum"]:
        sys.exit("crates.io package checksum mismatch")
    if runtime(published, version) != runtime(Path(archive).read_bytes(), version):
        sys.exit(f"Published ag-ui {version} differs from the candidate runtime or manifest")
    print("true")


if __name__ == "__main__":
    main()
