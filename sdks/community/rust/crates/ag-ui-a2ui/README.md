# ag-ui-a2ui

A2UI v0.9/v0.9.1 protocol types, lossless data-model replay, semantic and JSON
Schema validation, and provider-neutral async authoring. The crate produces and
checks UI descriptions; the application supplies the model and renderer.

## Minimal component validation

```rust
use ag_ui_a2ui::{Catalog, Component, Validator};
use serde_json::json;

let catalog = Catalog::basic();
let components = [Component::new("root", "Text").with("text", json!("Hello!"))];
assert!(Validator::new(&catalog).validate(&components).is_valid());
```

`Validator` checks graph, binding, envelope, and basic property constraints.
It does not claim full JSON Schema validation. `SchemaValidator` and
`SurfaceValidator` provide Draft 2020-12 validation behind `schema-validation`.

Missing or undefined bound values are accepted by default, including fields
initialized by user input or a later update. Malformed JSON Pointers and existing
non-array template collections still fail. To lint missing values as well, use
`Validator::with_options` with
`ValidateOptions { require_bound_values: true, ..Default::default() }`.
Both `validate_surface` and `validate_model` check every defined collection item,
including nested templates; the latter also preserves undefined array slots.

## Async authoring

Enable `author` for a complete shared schema/catalog contract. Enable
`ag-ui-server` to also send validated surfaces through an AG-UI `RunContext`.
Neither feature adds an executor, HTTP client, axum, or Tokio.

```rust
# #[cfg(feature = "author")]
# async fn example() -> ag_ui_a2ui::Result<()> {
use ag_ui_a2ui::{A2uiAuthor, A2uiVersion};
use serde_json::json;

let author = A2uiAuthor::basic(A2uiVersion::V0_9_1)?.with_send_data_model(true);
let surface = author.create("cart", "Show the cart title")
    .generate(|_prompt, _attempt| async {
        // Replace this deterministic provider with your async model client.
        Ok(json!([
            {"version":"v0.9.1","createSurface":{
                "surfaceId":"cart",
                "catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
                "sendDataModel":true
            }},
            {"version":"v0.9.1","updateComponents":{
                "surfaceId":"cart",
                "components":[{"id":"root","component":"Text","text":"Your cart"}]
            }}
        ]).to_string())
    }).await?;
assert_eq!(surface.surface_id(), "cart");
# Ok(())
# }
```

The callback receives an owned prompt and a one-based attempt number. Invalid
model documents receive correction prompts; provider failures propagate
immediately through `Error::generation`, preserving their source. Send callbacks
produce Send futures; local callbacks are also accepted.

`with_send_data_model(true)` requires `sendDataModel: true` on creation, asking
the renderer to attach current form input to later requests. The author includes
this flag in its prompt and validates generated or restored surfaces against it.
`false` accepts either an explicit false or omission; without the builder, either
setting is accepted.

`author.edit(&surface, request)` allows only updates to that existing surface.
A different surface ID, catalog, version, create, or delete is rejected. The
private `ValidatedSurface` fields prevent mutation after validation.
`operations()` is the current batch; `history()` includes the prior batches and
can be saved and revalidated with `validate_create`. Successful validation or
`ctx.send_a2ui(&surface)` only confirms local validation/enqueue, not renderer
receipt or application.

For typed, manually built `AgentMessage` batches, use
`author.validate_create_ops(surface_id, &operations)` or
`author.validate_edit_ops(&prior, &operations)`. Both perform the same full
schema and surface validation as the raw JSON methods, preserving the declared
version and omitted-versus-null data updates. Set each operation's version to
the author's profile, for example with `.with_version(A2uiVersion::V0_9_1)`.
Keep `validate_create` / `validate_edit` for untrusted raw JSON so validation
can reject unknown fields before typed decoding.

For manual `toolkit::recovery` calls, `RecoveredSurface.surface_id` identifies
the returned components and data model. Recovery selects the single live surface
touched by the response. If a response touches multiple live surfaces, set
`RecoveryOptions.target_surface_id`; an untouched or deleted target is rejected.
`operations` still contains the complete generated batch.

## Renderer messages

Use `RendererMessage::from_json(&raw)` with `schema-validation` to check the
original client message before serde applies compatibility defaults. This rejects
missing action `context`, missing error `surfaceId`, and validation errors without
`path`. For repeated messages, reuse `client_schema::ClientSchemaValidator` and its
`decode_message` method. Direct serde decoding remains available for applications
that need the tolerant low-level types.

Action and generic-error extension fields are retained in their `extensions`
maps, including null or structured `userMessage`, `path`, and `functionCallId`
values. `RendererError::path()` reads a validation error's string pointer.
Typed error codes remain strings, matching the official renderer; the raw JSON
Schema's generic-error code is less restrictive. `ClientCapabilitiesWire`
preserves extra version namespaces and capability fields while negotiating the
advertised v0.9 catalogs.

`ClientDataModel::from_json(&metadata)` reads `a2uiClientDataModel` snapshots
sent by renderers for surfaces with `sendDataModel: true`. Its `surfaces` map
contains the latest form input as JSON objects. The application selects an owned
surface, applies its snapshot through a root `updateDataModel`, and validates the
edit before generating a follow-up. The metadata type itself does not mutate state.

## Null and removal

```rust
use ag_ui_a2ui::{AgentMessage, DataModel, DataModelUpdate, ModelValue};
use serde_json::{json, Value};

let store_null = AgentMessage::update_data_model("cart", "/memo", Value::Null);
let remove = AgentMessage::remove_data_model_value("cart", "/memo");
assert!(serde_json::to_value(remove).unwrap()["updateDataModel"].get("value").is_none());

let mut model = DataModel::from(json!({"items": [null, 2]}));
model.apply("/items/1", &DataModelUpdate::Remove).unwrap();
assert_eq!(model.lookup("/items/0").unwrap(), Some(&ModelValue::Null));
assert_eq!(model.lookup("/items/1").unwrap(), None);
assert!(model.to_json().is_err()); // JSON cannot express the undefined slot.
```

Upserts create missing/null containers; numeric paths infer arrays and sparse gaps
are `Undefined`. Implicit array growth defaults to at most 65,536 new slots per
update; `apply_with_array_growth_limit` makes that allocation policy explicit.
A failed path or growth limit leaves the old model intact.

Deletion removes object keys, preserves array lengths with `Undefined` slots,
and leaves an `Undefined` root on root deletion. The versioned `DataModel`
snapshot preserves these values; plain JSON export fails if it would lose them.
`binding::ModelScope` and `Validator::validate_model` read the lossless model.
Plain JSON `Scope` and `UpdateDataModel::apply` remain available; the latter
rejects a result requiring Undefined instead of silently substituting null.

## Features and protocol

| Feature | Default | Adds |
| --- | --- | --- |
| `toolkit` | yes | Manual operations, prompts, parsing, history, sync/async recovery. |
| `ag-ui` | no | AG-UI history and tool definitions; implies `toolkit`. |
| `schema-validation` | no | Pinned full schemas, Draft 2020-12 engine, local references only. |
| `author` | no | `A2uiAuthor` and immutable `ValidatedSurface`; implies full validation. |
| `ag-ui-server` | no | `agui::A2uiRunContextExt::send_a2ui`; implies `author`, `ag-ui/server`. |

Default features include only `toolkit`, so an A2A or MCP consumer gets no AG-UI
dependency or schema engine. `default-features = false` selects the protocol
types alone. The schema engine is pinned to `jsonschema 0.29.1` without its
network/filesystem resolvers. Rust 1.85 and wasm builds are covered; browser
entropy support is target- and feature-specific to the schema engine.

Low-level constructors default to `v0.9`; `.with_version(A2uiVersion::V0_9_1)`
selects the other supported discriminator. Both accept the four server
operations: create, component update, data update, and delete. Candidate RPC
payload shapes are retained as Rust types but cannot be encoded/decoded as
v0.9-family messages; this is not v1.0 support.

`BASIC_CATALOG_ID` is a historical toolkit ID. `A2uiAuthor::basic` uses the
canonical `OFFICIAL_BASIC_CATALOG_ID` declared by the pinned schema. No alias is
inferred. Capabilities use `ClientCapabilitiesWire` with the `v0.9` namespace,
also for v0.9.1 messages. Negotiation requires an explicitly advertised matching
ID and keeps inline catalogs whole; conflicts or missing matches are errors.

The AG-UI integration carries a batch in an `a2ui_operations` tool result.
That envelope is an integration convention, not a mandatory A2UI transport.
The MIME type remains `application/a2ui+json`.

## Verification

`tests/official_examples.rs` validates all 43 pinned official basic catalog
examples against both their schemas and final surface state. Fixture provenance
is recorded in `tests/spec_v0_9/README.md`.

`tests/author.rs` exercises the official schema engine, local refs, targeted
async generation, catalog negotiation, and multi-surface transitions.
`tests/protocol_091.rs` covers lossless model/history replay and lifecycle.
The older toolkit conformance suite reports **110 direct matches, 9 expected
streaming divergences, 74 skipped, 0 unexpected failures**. The cases are
executed with pinned expectations: partial messages wait for a supported
version or an explicit data path, and only catalog-declared component
references are rewritten as placeholders. Four named policies requiring
implicit catalog fallback/cross-ID merging are explicitly superseded and
covered by replacement regressions. See
[conformance notes](tests/conformance/README.md) and [schema provenance](schemas/README.md).

```sh
cargo test -p ag-ui-a2ui --all-features
cargo +1.85.0 check -p ag-ui-a2ui --all-features
cargo check -p ag-ui-a2ui --all-features --target wasm32-unknown-unknown
```

License: MIT for SDK code; vendored official schemas retain Apache-2.0.
