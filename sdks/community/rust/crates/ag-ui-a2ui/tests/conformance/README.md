# Vendored A2UI conformance suite

The A2UI project ships its conformance tests as language-agnostic YAML and asks
every SDK to run them: read the YAML, feed the inputs to that language's
implementation, assert the outputs. These files are copied verbatim from
upstream and are driven by `crates/ag-ui-a2ui/tests/conformance.rs`.

- **Upstream:** <https://github.com/a2ui-project/a2ui>
- **Commit:** `44a420b67957fafc0b02d55a153fdaf72e32ffb5`
- **Path upstream:** `conformance/`
- **License:** Apache-2.0 (see the copyright headers in the YAML files)

Do not hand-edit these files. To update, re-copy from upstream at a newer commit
and change the SHA here and in `UPSTREAM_COMMIT` in the harness.

## Current standing: 119 passed, 74 skipped, 0 failed

| File | Cases | Checks executed here |
|---|---:|---|
| `core/validator.yaml` | 45 | 26 of 51 — every v0.9 structural case, the depth limits, the message envelope, and declared property types |
| `core/catalog.yaml` | 24 | 23 of 24 — prune, render, load, modifiers |
| `core/accessibility.yaml` | 4 | none |
| `agent/parser.yaml` | 19 | 19 — all of them |
| `agent/inference_format.yaml` | 19 | 13 of 19 — supported catalog negotiation and prompt policies |
| `agent/streaming_parser.yaml` | 76 | 38 of 76 — every v0.9 case |
| `test_data/` | — | fixtures the cases above load |

A case with `steps` counts as one check per step, so the check totals exceed the
case counts in places.

## Why cases are skipped

Every case the harness cannot execute is skipped **with a reason and a count**,
printed by the test. Nothing is silently ignored, and no case is counted as
passing unless this crate actually produced the expected outcome. Run

```
cargo test -p ag-ui-a2ui --all-features -- --nocapture
```

to see the report, and set `A2UI_CONFORMANCE_VERBOSE=1` to list every check by
name.

The 74 skips break down as:

| Count | Reason |
|---:|---|
| 4 | **Superseded toolkit policy.** Default fallback and cross-ID inline merging conflict with the reviewed contract. `toolkit::negotiate` tests enforce explicit matching, complete inline documents, and conflict rejection. |
| 63 | **v0.8 wire format.** v0.8 nests component properties under the type name (`component: {Text: {...}}`) and uses different message names. This crate implements v0.9, where components are flat. |
| 4 | **Renderer accessibility.** Accessibility trees and axe-core rules belong to a renderer; this crate does not render. |
| 2 | **v0.8 schema bundle in a prompt.** Two `generate_prompt` cases ask for the v0.8 schema documents to be embedded in the prompt; this crate ships v0.9. The other six prompt cases run. |
| 1 | **JSON Schema validation of an example file.** `test_load_examples_validation_fails_on_schema_error` asks `load_examples` to validate each example against an arbitrary `s2c_schema` — a whole JSON Schema engine over a document the caller supplies, which is the one part of upstream's schema story this crate does not reproduce. |

The other five JSON Schema cases now run. Upstream validates the message
envelope and component property types with a JSON Schema engine; this crate
checks both natively — the envelope against the v0.9 contract it pins, property
values against the types the catalog declares (`PropType`) — and reports the same
codes (`missing_field`, `invalid_value`, `type_mismatch`), so the cases asserting
those codes and messages are executed rather than skipped.

The depth-limit cases now pass: `ValidateOptions::max_depth` defaults to 50 and
`max_function_call_depth` to 5, matching every other toolkit, and a payload past
either reports `max_depth_exceeded`.

Version gating is applied only where the version actually matters. `validate`
and `process_chunk` are wire-format operations and are gated; schema surgery
(`prune`, `render`, `load`, `remove_strict_validation`) works on the shape of
the documents rather than on the protocol, so those run for v0.8 cases too.

## Two deliberate differences

**Unreachable components are a warning, not an error.**
`test_validate_orphaned_component_v09` expects an error when a component cannot
be reached from `root`. This crate reports that as
`ValidationReport::unreachable`, because the specification tells renderers to
buffer components until their parent arrives, so an unreachable component is
usually a half-streamed tree rather than a broken one. The harness therefore
asserts the condition is *detected*, not that it is fatal. This is the only
place the harness maps an upstream expectation onto a different severity, and it
is called out in `classify_expectation`.

**Validator cases run at upstream's scope.** For the `validate` cases the
harness turns off component-type and required-property checking, because
upstream delegates those to JSON Schema in the cases being compared, and turns
off data-binding resolution, because upstream's structural validator does not
look at bindings. Pointer *syntax* checking stays on, since upstream checks that
too, as do the envelope and property-type checks, since those are what the cases
delegated to JSON Schema assert. Matching upstream's scope is what makes the
comparison meaningful.

## v0.9.1 regression coverage

The full official schemas are pinned separately in `schemas/v0_9_1/` at
`1c45c809b655878d06e3afc6dda22100afecc0a4`. `tests/author.rs` checks the actual
Draft 2020-12 engine, local refs, async recovery, targeted edits, and
multi-catalog transactional streams. `tests/protocol_091.rs` checks lifecycle,
null/removal/Undefined, snapshots, and fallible history replay.

Legacy structural vectors without a create or prior state exercise the
component-fragment entry point. Create-only steps exercise pending lifecycle,
not final tree validation. The new whole-stream tests require explicit state.
These adaptations do not claim the legacy toolkit policies conform to v0.9.1.
