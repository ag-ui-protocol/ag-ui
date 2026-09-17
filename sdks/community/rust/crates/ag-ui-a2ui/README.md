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

## Async authoring

Enable `author` for a complete shared schema/catalog contract. Enable
`ag-ui-server` to also send validated surfaces through an AG-UI `RunContext`.
Neither feature adds an executor, HTTP client, axum, or Tokio.

```rust
# #[cfg(feature = "author")]
# async fn example() -> ag_ui_a2ui::Result<()> {
use ag_ui_a2ui::{A2uiAuthor, A2uiVersion};
use serde_json::json;

let author = A2uiAuthor::basic(A2uiVersion::V0_9_1)?;
let surface = author.create("cart", "Show the cart title")
    .generate(|_prompt, _attempt| async {
        // Replace this deterministic provider with your async model client.
        Ok(json!([
            {"version":"v0.9.1","createSurface":{
                "surfaceId":"cart",
                "catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"
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

`author.edit(&surface, request)` allows only updates to that existing surface.
A different surface ID, catalog, version, create, or delete is rejected. The
private `ValidatedSurface` fields prevent mutation after validation.
`operations()` is the current batch; `history()` includes the prior batches and
can be saved and revalidated with `validate_create`. Successful validation or
`ctx.send_a2ui(&surface)` only confirms local validation/enqueue, not renderer
receipt or application.

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
| `ag-ui` | yes | AG-UI history and tool definitions; implies `toolkit`. |
| `schema-validation` | no | Pinned full schemas, Draft 2020-12 engine, local references only. |
| `author` | no | `A2uiAuthor` and immutable `ValidatedSurface`; implies full validation. |
| `ag-ui-server` | no | `agui::A2uiRunContextExt::send_a2ui`; implies `author`, `ag-ui/server`. |

With default features disabled, the core has no schema engine or AG-UI
dependency. The schema engine is pinned to `jsonschema 0.29.1` without its
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

`tests/author.rs` exercises the official schema engine, local refs, targeted
async generation, catalog negotiation, and multi-surface transitions.
`tests/protocol_091.rs` covers lossless model/history replay and lifecycle.
The older toolkit conformance suite reports **119 passed, 74 skipped, 0 failed**;
four named policies requiring implicit catalog fallback/cross-ID merging are
explicitly superseded and covered by replacement regressions. See
[conformance notes](tests/conformance/README.md) and [schema provenance](schemas/README.md).

```sh
cargo test -p ag-ui-a2ui --all-features
cargo +1.85.0 check -p ag-ui-a2ui --all-features
cargo check -p ag-ui-a2ui --all-features --target wasm32-unknown-unknown
```

License: MIT for SDK code; vendored official schemas retain Apache-2.0.
