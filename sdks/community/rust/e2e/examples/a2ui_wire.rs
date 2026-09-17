//! Export real SDK operations for the separately installed official web core.

use ag_ui::server::RunContext;
use ag_ui::{Event, RunAgentInput};
use ag_ui_a2ui::agui::A2uiRunContextExt;
use ag_ui_a2ui::constants::OFFICIAL_BASIC_CATALOG_ID;
use ag_ui_a2ui::surface::SurfaceStore;
use ag_ui_a2ui::{A2uiAuthor, A2uiVersion, AgentMessage, Component};
use serde::Serialize;
use serde_json::{Value, json};

type AppResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Serialize)]
struct Step {
    name: &'static str,
    messages: Vec<AgentMessage>,
}

/// Serializes authored AG-UI tool results and typed low-level A2UI updates.
/// No field is changed by the JavaScript consumer before processing.
pub async fn fixture() -> AppResult<Value> {
    let version = A2uiVersion::V0_9_1;
    let id = "official-interop";
    let author = A2uiAuthor::basic(version)?;
    let initial = vec![
        AgentMessage::create_surface(id, OFFICIAL_BASIC_CATALOG_ID).with_version(version),
        AgentMessage::update_components(
            id,
            vec![
                Component::new("root", "Column").with("children", json!(["title"])),
                Component::new("title", "Text").with("text", json!({"path": "/title"})),
            ],
        )
        .with_version(version),
        AgentMessage::update_data_model(id, "/", json!({"title": "Original review", "memo": null}))
            .with_version(version),
    ];
    let response = serde_json::to_string(&initial)?;
    let created = author
        .create(id, "Create the review card")
        .generate(|_, _| {
            let response = response.clone();
            async move { Ok(response) }
        })
        .await?;
    let change = AgentMessage::update_data_model(id, "/title", json!("Reviewed title"))
        .with_version(version);
    let response = serde_json::to_string(&[change])?;
    let edited = author
        .edit(&created, "Update only the title")
        .generate(|_, _| {
            let response = response.clone();
            async move { Ok(response) }
        })
        .await?;

    // Extract the exact payloads send_a2ui put in TOOL_CALL_RESULT; this also
    // exercises the optional AG-UI integration, not only a hand-written fixture.
    let (mut ctx, mut receiver) = RunContext::<()>::new(RunAgentInput::new("interop", "export"))?;
    ctx.send_a2ui(&created)?;
    ctx.send_a2ui(&edited)?;
    let mut batches = receiver.drain().into_iter().filter_map(|event| {
        let Event::ToolCallResult(result) = event else {
            return None;
        };
        Some(serde_json::from_str::<Value>(&result.content))
    });
    let create = ag_ui_a2ui::toolkit::envelope::unwrap_operations_envelope(
        &batches.next().ok_or("missing create batch")??,
    )?;
    let edit = ag_ui_a2ui::toolkit::envelope::unwrap_operations_envelope(
        &batches.next().ok_or("missing edit batch")??,
    )?;
    let mut steps = vec![
        Step {
            name: "create",
            messages: create,
        },
        Step {
            name: "edit",
            messages: edit,
        },
    ];
    steps.push(Step {
        name: "explicit-null",
        messages: vec![
            AgentMessage::update_data_model(id, "/memo", Value::Null).with_version(version),
            AgentMessage::update_data_model(id, "/discard", json!("temporary"))
                .with_version(version),
            AgentMessage::update_data_model(id, "/items", json!([1, null, 3]))
                .with_version(version),
        ],
    });
    steps.push(Step {
        name: "upsert-missing-array",
        messages: vec![
            AgentMessage::update_data_model(id, "/list/0", json!("first")).with_version(version),
        ],
    });
    steps.push(Step {
        name: "upsert-null-parent",
        messages: vec![
            AgentMessage::update_data_model(id, "/nullable", Value::Null).with_version(version),
            AgentMessage::update_data_model(id, "/nullable/name", json!("nested"))
                .with_version(version),
            AgentMessage::update_data_model(id, "/nullableArray", Value::Null)
                .with_version(version),
            AgentMessage::update_data_model(id, "/nullableArray/0", json!("first"))
                .with_version(version),
        ],
    });
    steps.push(Step {
        name: "upsert-sparse-array",
        messages: vec![
            AgentMessage::update_data_model(id, "/list/3", json!("fourth")).with_version(version),
            AgentMessage::update_data_model(id, "/sparse/2", json!("third")).with_version(version),
            AgentMessage::remove_data_model_value(id, "/list/5").with_version(version),
        ],
    });
    steps.push(Step {
        name: "upsert-nested-array",
        messages: vec![
            AgentMessage::update_data_model(id, "/matrix/0/1", json!("inner"))
                .with_version(version),
        ],
    });
    steps.push(Step {
        name: "remove-object-key",
        messages: vec![AgentMessage::remove_data_model_value(id, "/discard").with_version(version)],
    });
    steps.push(Step {
        name: "remove-array-slot",
        messages: vec![AgentMessage::remove_data_model_value(id, "/items/1").with_version(version)],
    });
    steps.push(Step {
        name: "replace-component",
        messages: vec![
            AgentMessage::update_components(
                id,
                vec![Component::new("title", "Text").with("text", json!("Replacement text"))],
            )
            .with_version(version),
        ],
    });
    steps.push(Step {
        name: "upsert-null-root",
        messages: vec![
            AgentMessage::update_data_model(id, "/", Value::Null).with_version(version),
            AgentMessage::update_data_model(id, "/name", json!("root restored"))
                .with_version(version),
        ],
    });
    steps.push(Step {
        name: "delete",
        messages: vec![AgentMessage::delete_surface(id).with_version(version)],
    });
    steps.push(Step {
        name: "recreate",
        messages: vec![
            AgentMessage::create_surface(id, OFFICIAL_BASIC_CATALOG_ID).with_version(version),
            AgentMessage::update_components(
                id,
                vec![Component::new("root", "Text").with("text", json!("Recreated surface"))],
            )
            .with_version(version),
            AgentMessage::update_data_model(id, "/", json!({"title":"Fresh review"}))
                .with_version(version),
        ],
    });

    // Every exported operation also traverses the SDK's public state machine.
    // Undefined is preserved locally; no snapshot value is sent as wire data.
    let mut store = SurfaceStore::new();
    let mut exported_steps = Vec::new();
    for step in &steps {
        for message in &step.messages {
            store.apply(message)?;
        }
        let mut exported = serde_json::to_value(step)?;
        exported["sdkData"] = serde_json::to_value(
            store
                .get(id)
                .filter(|surface| !surface.deleted)
                .map(|surface| &surface.data_model),
        )?;
        exported_steps.push(exported);
    }
    let final_data = store
        .get(id)
        .ok_or("recreated surface missing")?
        .data_model
        .to_json()?;
    Ok(
        json!({"version": version.as_str(), "catalogId": OFFICIAL_BASIC_CATALOG_ID,
        "surfaceId": id, "steps": exported_steps, "finalSdkData": final_data}),
    )
}

#[tokio::main]
async fn main() -> AppResult<()> {
    println!("{}", fixture().await?);
    Ok(())
}
