# Real HTTP interoperability fixture

This is a **test-only** separate Cargo workspace, not an application server.
It uses the public core request boundary, the public live encoder, the Rust
`Agent::run_input` lifecycle helper, and the official TypeScript `HttpAgent`.
It has no external model service, real credentials, scheduler, or durable store.

## Prerequisites and commands

Rust 1.88.0+, Node matching the root `.node-version`, pnpm 10.33.4, Python 3,
and the independent schema oracle `jsonschema==4.26.0` are required. Missing
prerequisites fail the lane; these tests never silently skip TypeScript proof.

From the repository root:

```sh
pnpm install --frozen-lockfile --filter @ag-ui/client... --filter ag-ui
pnpm exec nx build @ag-ui/client
python3 -m pip install jsonschema==4.26.0
cd sdks/community/rust
mkdir -p tests/interop/evidence
cargo +1.88.0 fmt --manifest-path tests/interop/Cargo.toml --all -- --check
cargo +1.88.0 clippy --manifest-path tests/interop/Cargo.toml --all-targets --locked -- -D warnings
cargo +1.88.0 test --manifest-path tests/interop/Cargo.toml --all-targets --locked
cargo +1.88.0 build --manifest-path tests/interop/Cargo.toml --bins --locked
cargo +1.88.0 run --manifest-path tests/interop/Cargo.toml --locked --bin rust-probe -- tests/interop/evidence/rust.json
node tests/interop/fixture-client.mjs tests/interop/target/debug/fixture-host tests/interop/evidence/typescript.json
python3 tests/interop/verify.py tests/interop/evidence/rust.json tests/interop/evidence/typescript.json
```

On Windows the fixture-host binary has an `.exe` suffix. The required
cross-language CI lane is Linux; portable Rust library/decoder tests run on all
three OSes. The complete evidence is JSON, suitable for CI artifact retention.

## What is actually proven

Each client makes eight real localhost HTTP exchanges over four two-turn
scenarios in `scenarios.json`. Exact independently authored expected requests,
complete result histories, state, events, and callback counts are compared.

- Ordinary same-thread turns replace one message and remove another. The second
  request comes only from the public complete history result, with activity
  filtered at HTTP egress. Unicode, image source metadata, opaque encrypted
  values, nested null, subagent invocation attribution, and patch extras survive.
- Null restart ends run one at required snapshot null, omits whole-null state on
  the next wire request, observes effective `{}` at host admission, then reapplies
  canonical null before a root patch to a JSON array.
- Two frontend tool results preserve separate IDs, correlation, metadata, and
  explicit error content.
- Two interrupt answers preserve parent identity, resolved/cancelled status,
  nested null, context, and opaque forwarded properties.

The host uses ephemeral ports, one bounded request per process/lifetime, dummy
bearer authentication, finite request/read/write limits, and owned cleanup. It
parses both Content-Length and chunked requests. Admission failures for an
unsupported major or malformed known input are HTTP errors with no SSE headers
or `RUN_STARTED`. Every valid response is encoded by `encode_live`; no hand-built
JSON/SSE formatter substitutes for the public producer.

The Rust probe recreates host and HTTP client objects between turns and carries
only public result state. The TypeScript controller additionally starts a fresh
host process and client process for every exchange, carrying the public
`client.messages`/`client.state` across files. Parent identity is supplied through
the official TS `onRunInitialized` input hook because `RunAgentParameters` does
not expose `parentRunId`. No TS runtime source is changed for the fixture.

Socket writes are intentionally small, but do not claim any particular HTTP
chunk partition. The client's deterministic decoder tests separately enumerate
byte partitions. Comments between all events must never become data events.

## Independent oracles and source provenance

`verify.py` checks actual encoder bytes for UTF-8/LF-only framing and comments,
validates each emitted event and request using the checked-out JSON Schema with
Python `jsonschema`, and independently checks the scenario's run/text/subagent
ordering. It compares exact application events/history and captured requests.
Missing rows, duplicate rows, unknown rows, missing/null substitutions, and
payload changes fail. Five deliberate evidence mutations must be rejected.

`verify.py` records the checked-out TypeScript client package version and
`git rev-parse HEAD:sdks/typescript/packages/client` in a `.provenance.json`
sidecar for each evidence file. CI uploads these alongside the actual exchanges.
The historical `pins.json` is not a gate: unrelated TypeScript releases must not
break Rust CI. Behavioral differences fail the live exchange and schema checks.
PR interoperability tests use the merge result; the separate Git consumer tests
the reachable contributor head.

This workspace's path dependencies prove local integration only. The separate
[Git consumer gate](../external-consumer/README.md) proves downstream dependency
resolution. Neither fixture is evidence of a real Crabber/server integration.
