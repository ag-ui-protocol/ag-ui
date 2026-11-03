# Independent immutable Git consumer

This gate starts outside the source workspace, fetches a public immutable
candidate revision, and verifies the dependency graph before compiling and
running real HTTP exchanges.

## Exact dependency recipe

Replace every `FULL_40_HEX_COMMIT` below with the **same reachable commit** from a
successful `proof.json`. A branch name or unpushed local hash is not a pin.

```toml
[dependencies]
ag-ui-core = { git = "https://github.com/ag-ui-protocol/ag-ui.git", rev = "FULL_40_HEX_COMMIT" }
ag-ui-client = { git = "https://github.com/ag-ui-protocol/ag-ui.git", rev = "FULL_40_HEX_COMMIT" }
ag-ui-encoder = { git = "https://github.com/ag-ui-protocol/ag-ui.git", rev = "FULL_40_HEX_COMMIT" }

```

Path-and-version dependencies keep the client and encoder connected to the
same core crate in that Git checkout, without a consumer patch table.

## Run the proof

After an authorized push, from the Rust workspace:

```sh
python3 tests/external-consumer/verify.py \
  --repo https://github.com/ag-ui-protocol/ag-ui.git \
  --rev FULL_40_HEX_COMMIT --toolchain 1.88.0 \
  --output /tmp/ag-ui-consumer-proof
```

The output directory must be new and outside the source checkout. Requirements:
Rust/rustup, Git, Python, the `jsonschema==4.26.0` oracle, and public network access
for the Git revision and registry dependencies. No credentials, access tokens,
local Git remotes, sibling paths, or hidden global Cargo config are used.
An inaccessible required revision/dependency is a failed/blocked proof, not a
skipped success. The script never pushes, publishes, or merges anything.

The script:

1. Fetches the exact revision from the public remote, independent of local Git
   objects; branch names and credential-bearing URLs are rejected.
2. Materializes a separate consumer with copied **test harness source**, a
   standalone manifest, and Git-only SDK dependencies. No SDK source is copied.
3. Resolves its own lock once in a separate resolution directory, or reuses the
   exact lock supplied with `--lockfile`.
4. Copies that lock and manifest into a fresh independent consumer and uses
   `--locked` for metadata, tests, and the executable HTTP proof. The lock hash
   must remain unchanged.
5. Checks all three SDK packages resolve to the requested Git URL/revision, with
   exactly one core identity shared by client and encoder. Any hidden path
   dependency or duplicate SDK identity fails. Ordinary transitive duplicates
   are fully recorded for review in metadata and `cargo tree -d`.
6. Compiles tests and executes the public producer/client eight-exchange probe,
   then independently schema-checks its actual wire evidence.

Retain `proof.json` (compiler, commands, status, source tuple, lock hash),
`consumer/Cargo.toml`, `consumer/Cargo.lock`, `metadata.json`,
`duplicate-tree.txt`, and `rust-http-proof.json`. Reproducing the exact lock is:

```sh
python3 tests/external-consumer/verify.py \
  --repo https://github.com/ag-ui-protocol/ag-ui.git --rev FULL_40_HEX_COMMIT \
  --toolchain 1.88.0 --lockfile /tmp/ag-ui-consumer-proof/consumer/Cargo.lock \
  --output /tmp/ag-ui-consumer-proof-recheck
```

There is deliberately no fabricated lock pinned to an unpushed candidate in this
source tree. Each evidence consumer owns and retains its real lock. CI uses the
reachable pull-request head (including public forks), not a synthetic merge ref,
and uploads the exact lock/proof artifacts. A source change requires a new
immutable revision and a new run; an earlier proof is not evidence for later code.

## Registry packaging is a different gate

CI runs `cargo +stable publish --workspace --dry-run --locked` to package and
verify the crates together before publication. This Git gate neither releases
crates nor certifies downstream host policy, storage, or application integration.
