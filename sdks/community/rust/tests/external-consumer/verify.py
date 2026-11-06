#!/usr/bin/env python3
"""Build a fresh, locked consumer of a reachable immutable public Git revision.

No workspace patches or path dependencies are reused. Resolution and locked proof
are distinct: the resolved lock is copied into a second clean workspace, then every
build/run/metadata command for the evidence consumer uses --locked.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
INTEROP = HERE.parent / "interop"
ROOT = HERE.parents[4]
SDK = ("ag-ui-core", "ag-ui-client", "ag-ui-encoder")


def command(args, cwd, env, log, *, capture=False):
    log.append({"cwd": str(cwd), "command": args})
    print("+", " ".join(args), flush=True)
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=900)
    log[-1].update(returncode=result.returncode, stdout=result.stdout, stderr=result.stderr)
    if result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(args)}\n{result.stdout}\n{result.stderr}")
    return result.stdout if capture else None


def manifest(repo, revision):
    dependencies = "\n".join(f'{name} = {{ git = "{repo}", rev = "{revision}" }}' for name in SDK)
    return f'''[package]
name = "ag-ui-independent-consumer"
version = "0.0.0"
edition = "2024"
rust-version = "1.88"
publish = false

[lib]
name = "ag_ui_interop_fixture"

[workspace]
resolver = "3"

[dependencies]
{dependencies}
async-trait = "0.1.88"
serde = {{ version = "1", features = ["derive"] }}
serde_json = "1"
tokio = {{ version = "1.36.0", features = ["macros", "rt-multi-thread"] }}

'''


def check_sources(metadata, repo, revision):
    root_id = metadata["resolve"]["root"]
    packages = metadata["packages"]
    by_id = {package["id"]: package for package in packages}
    selected = {}
    for name in SDK:
        matches = [package for package in packages if package["name"] == name]
        if len(matches) != 1:
            raise AssertionError(f"expected one source identity for {name}, found {len(matches)}")
        package = matches[0]
        source = package["source"]
        expected = f"git+{repo}?rev={revision}#{revision}"
        if source != expected:
            raise AssertionError(f"wrong {name} source: {source!r}; expected {expected!r}")
        selected[name] = {"id": package["id"], "version": package["version"], "source": source}
    for package in packages:
        if package["id"] != root_id and package["source"] is None:
            raise AssertionError(f"hidden local/path dependency: {package['name']}")
    core_id = selected["ag-ui-core"]["id"]
    for name in ("ag-ui-client", "ag-ui-encoder"):
        node = next(node for node in metadata["resolve"]["nodes"] if node["id"] == selected[name]["id"])
        cores = [dep["pkg"] for dep in node["deps"] if by_id[dep["pkg"]]["name"] == "ag-ui-core"]
        if cores != [core_id]:
            raise AssertionError(f"{name} is not connected to the consumer's exact public core identity")
    # General transitive duplicates may be harmless: record every one, but SDK
    # duplicates above are hard failures, never waived by a tree -d snapshot.
    versions = {}
    for package in packages:
        versions.setdefault(package["name"], set()).add((package["version"], package["source"]))
    duplicates = {name: sorted(values, key=str) for name, values in versions.items() if len(values) > 1}
    return selected, duplicates


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="public https://github.com/OWNER/REPO.git")
    parser.add_argument("--rev", required=True, help="reachable full 40-hex candidate commit, never a branch")
    parser.add_argument("--output", type=Path, required=True, help="new evidence directory outside the source checkout")
    parser.add_argument("--toolchain", default="stable")
    parser.add_argument("--lockfile", type=Path, help="reuse a previously resolved consumer lock rather than resolve again")
    args = parser.parse_args()
    if not re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git", args.repo):
        parser.error("use a credential-free public GitHub HTTPS repository URL")
    if not re.fullmatch(r"[0-9a-f]{40}", args.rev):
        parser.error("--rev must be an immutable full lowercase Git commit hash")
    output = args.output.resolve()
    if output == ROOT or ROOT in output.parents:
        parser.error("--output must be outside the source repository")
    for ancestor in (output, *output.parents):
        for config_name in ("config", "config.toml"):
            if (ancestor / ".cargo" / config_name).exists():
                parser.error(f"ancestor Cargo config would affect the independent consumer: {ancestor}")
    output.mkdir(parents=True, exist_ok=False)
    log = []
    env = {key: value for key, value in os.environ.items() if not key.startswith(("CARGO_", "GIT_")) and key not in (
        "RUSTFLAGS", "RUSTDOCFLAGS", "RUSTC_BOOTSTRAP", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTC", "GIT_DIR", "GIT_WORK_TREE")}
    env.update(CARGO_HOME=str(output / "cargo-home"), CARGO_NET_GIT_FETCH_WITH_CLI="true",
               GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0")
    cargo = ["cargo", f"+{args.toolchain}"]
    report = {"status": "blocked", "repository": args.repo, "revision": args.rev, "commands": log}
    try:
        # Check reachability from the public remote, not the caller's local object store.
        remote = output / "remote-check"
        remote.mkdir()
        command(["git", "init", "--quiet"], remote, env, log)
        command(["git", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "fetch", "--depth=1", args.repo, args.rev], remote, env, log)
        fetched = command(["git", "rev-parse", "FETCH_HEAD"], remote, env, log, capture=True).strip()
        assert fetched == args.rev, "public remote did not resolve the exact candidate commit"
        harness_hashes = {}
        for source in sorted([*(INTEROP / "src").rglob("*.rs"), INTEROP / "scenarios.json"]):
            relative = source.relative_to(ROOT).as_posix()
            remote_bytes = subprocess.check_output(["git", "show", f"FETCH_HEAD:{relative}"], cwd=remote, env=env)
            if remote_bytes != source.read_bytes():
                raise AssertionError(f"test harness differs from the selected immutable candidate: {relative}")
            harness_hashes[relative] = hashlib.sha256(remote_bytes).hexdigest()
        report["harnessSha256"] = harness_hashes
        resolution = output / "resolution"
        resolution.mkdir()
        (resolution / "Cargo.toml").write_text(manifest(args.repo, args.rev))
        shutil.copytree(INTEROP / "src", resolution / "src")
        shutil.copy2(INTEROP / "scenarios.json", resolution / "scenarios.json")
        if args.lockfile:
            shutil.copy2(args.lockfile, resolution / "Cargo.lock")
        else:
            command(cargo + ["generate-lockfile"], resolution, env, log)
        # A genuinely separate consumer, with its own manifest, source, and lock.
        consumer = output / "consumer"
        shutil.copytree(resolution, consumer)
        lock_before = hashlib.sha256((consumer / "Cargo.lock").read_bytes()).hexdigest()
        compiler = command(["rustc", f"+{args.toolchain}", "--version", "--verbose"], consumer, env, log, capture=True)
        metadata = json.loads(command(cargo + ["metadata", "--format-version", "1", "--locked"], consumer, env, log, capture=True))
        selected, duplicates = check_sources(metadata, args.repo, args.rev)
        (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
        tree = command(cargo + ["tree", "--locked", "-d"], consumer, env, log, capture=True)
        (output / "duplicate-tree.txt").write_text(tree)
        command(cargo + ["test", "--all-targets", "--locked"], consumer, env, log)
        proof = output / "rust-http-proof.json"
        command(cargo + ["run", "--locked", "--bin", "rust-probe", "--", str(proof)], consumer, env, log)
        # The independent schema checker reads evidence only, not its Rust deps.
        command(["python3", str(INTEROP / "verify.py"), str(proof)], ROOT, env, log)
        assert hashlib.sha256((consumer / "Cargo.lock").read_bytes()).hexdigest() == lock_before, "locked proof modified its lock"
        report.update(status="passed", compiler=compiler, sdkSources=selected,
                      transitiveDuplicates=duplicates, lockSha256=lock_before,
                      dependencyNote="Only non-SDK transitive versions may duplicate; public SDK source identities are unique.")
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        (output / "proof.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Independent immutable Git consumer passed; own manifest/lock/evidence: {output}")


if __name__ == "__main__":
    main()
