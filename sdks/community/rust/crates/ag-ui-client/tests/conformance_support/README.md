# Rust conformance oracle

The shared stream corpus is discovered from its manifest. New cases are normative
by default; `classification.json` records explicit overrides and exclusions.
Applicable cases execute through the public HTTP client and explicit-input
lifecycle. Three optional old-peer shims remain out of scope: content flattening,
subagent downgrade, and protocol-version declaration omission. Always-on THINKING
translation and binary-content upgrades are exercised by the shared cases.

Legacy binary fixture input is upgraded as raw JSON before constructing the
modern typed `RunAgentInput`: the 1.0 content union intentionally has no binary
variant. This representation adapter preserves activity messages in application
history. It is distinct from the HTTP projection, which removes activity messages
and declares the current protocol version. The stream oracle checks the actual
HTTP body after that projection; it does not claim legacy binary parts can enter
through the typed request API. The public `prepare_run_input_value` raw preparation
path is independently tested in core's `raw_input_preparation` suite, including
binary conversion, mirror deduplication, activity filtering, validation, and
parity with typed preparation for modern inputs.

The unknown optional text-role case follows the canonical TypeScript/Python
behavior: an unknown present role fails. Its former Rust-only tolerance override
has been removed. Malformed-known-value overrides only replace validator-specific
English with Rust's semantic error category and path, and assert non-delivery.
TypeScript and .NET expectations are unchanged.

All 14 expectation keys are implemented. The oracle sees application-delivered
canonical events, structured boundary and reducer diagnostics, finalized
messages/state, and the actual complete HTTP body and relevant headers. A
producer RUN_ERROR is counted only from a delivered event, never from a
consumer exception. Empty object subsets require an actual object, present
null never matches absence, and arrays retain exact order and length.

The historical positive corpus predates request-ID assertions. Its request
uses the last announced run's IDs unless fixture input explicitly supplies
them; response events are never rewritten. Independent identity-parity
client tests author mismatched requests separately and verify they are accepted
like TypeScript while lifecycle ordering is still enforced. Every input field is preserved and
unsupported client configuration is classified instead of ignored.

`http.rs` parses both Content-Length and chunked request bodies, including
headers/body boundaries and trailers. Both capture and execution are bounded.
Negative controls prove event loss, patch-extra loss, metadata loss,
missing/null confusion, required/unwanted warnings, changed request fields,
consumer/producer-error conflation and manifest/expectation-key mutations fail.

The separate core `spec_fixtures` suite validates all 135 valid and 84 invalid
documents plus their 84 exact diagnostic companions using jsonschema 0.33
against the pinned Draft 2020-12 schema. It deterministically resolves the
validator's `$ref` evaluation paths into the companion schema locations.
Typed representation and production normalization are separate lanes; the
encoder suite owns real producer egress of all 35 null-omission cases.

Baseline protocol pins (before Rust lane metadata):

- schema blob: `c2ce3c18036b6bb2afe583a9b916959e7dcd9b78`
- stream MANIFEST blob: `40a6774745bc620465164b0e59efed2d7461f682`
- stream tree: `36faadc4c40b0458e9bd0118ce007ca5087c028d`
- shared SDK fixtures tree: `e6dd6fd9d264a9af6c231d4865244a3ed85d99be`

Changing fixture metadata updates the stream tree, not the protocol schema or
inventory. Tests fail on duplicate/stale manifest entries, omitted files,
stale scope classifications, unknown expectation keys and vacuous cases.
