//! The two tool definitions an A2UI agent exposes.
//!
//! They sit at different levels and are easy to confuse:
//!
//! - [`generate_a2ui_tool`] is **planner-facing**. The orchestrating model calls
//!   it to say "render this, as a new surface or as an edit to that one". Its
//!   arguments are intent and description, not components.
//! - [`render_a2ui_tool`] is the **inner structured-output** tool. The
//!   generating model calls it to emit the actual surface: a flat component list
//!   and a data model.
//!
//! Keeping them apart is what lets the planner stay out of the component
//! catalog: it describes what it wants, and the inner call produces it.

use serde_json::{Value, json};

use crate::catalog::Catalog;
use crate::constants::{
    DEFAULT_SURFACE_ID, GENERATE_A2UI_TOOL_NAME, RENDER_A2UI_TOOL_NAME, ROOT_ID,
};

/// A provider-neutral tool definition.
///
/// `parameters` is a JSON Schema object; every major LLM API takes that shape,
/// under whatever key it calls it.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDefinition {
    /// The tool name the model calls.
    pub name: &'static str,
    /// What the tool does, as the model sees it.
    pub description: String,
    /// JSON Schema for the tool's arguments.
    pub parameters: Value,
}

impl ToolDefinition {
    /// Renders the definition in Anthropic's Messages API shape:
    /// `{name, description, input_schema}`.
    ///
    /// Named for the provider because the key is: Anthropic calls the schema
    /// `input_schema`, OpenAI nests it under `function.parameters`, and Gemini
    /// wants `parameters` with a restricted subset of JSON Schema. The struct's
    /// own fields are the provider-neutral form; reach for those, or for
    /// [`ag_ui::Tool`](https://docs.rs/ag-ui/0.4.2/ag_ui/tool/struct.Tool.html)
    /// via `From` under the `ag-ui` feature, when the target is anything else.
    pub fn to_anthropic_value(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "input_schema": self.parameters,
        })
    }
}

/// The planner-facing tool: ask for a surface.
///
/// The `intent` argument is the important one. `"update"` targets a surface that
/// already exists and must not be re-created; `"create"` allocates a new
/// `surface_id`. The description spells that out because the planner is the only
/// one who knows which the user meant.
pub fn generate_a2ui_tool() -> ToolDefinition {
    ToolDefinition {
        name: GENERATE_A2UI_TOOL_NAME,
        description: "Render an interactive UI surface for the user. Use this instead of \
                      describing a UI in prose. Set intent to 'create' for a new surface, or \
                      'update' to change a surface already on screen — updating keeps the \
                      existing surface_id and never re-creates it."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "intent": {
                    "type": "string",
                    "enum": ["create", "update"],
                    "description": "'create' builds a new surface; 'update' edits the surface \
                                    already on screen. Re-creating an existing surface is an \
                                    error, so use 'update' whenever one exists.",
                    "default": "create"
                },
                "surface_id": {
                    "type": "string",
                    "description": format!(
                        "The surface to target. Required for 'update'; for 'create' it must be \
                         unused. Defaults to '{DEFAULT_SURFACE_ID}'."
                    )
                },
                "request": {
                    "type": "string",
                    "description": "What the UI should show or let the user do, in plain \
                                    language. Include the concrete data to display."
                },
                "design_notes": {
                    "type": "string",
                    "description": "Optional layout or styling guidance, e.g. 'compact list, \
                                    primary action at the bottom'."
                }
            },
            "required": ["intent", "request"]
        }),
    }
}

/// The inner structured-output tool: emit the surface.
///
/// The schema restates the adjacency-list rules, because the model filling it in
/// is the one that has to get them right: a flat list, ids not nesting, exactly
/// one `root`.
///
/// Pass a catalog to name the permitted component types in the schema, which
/// keeps the model inside them without relying on the prompt alone.
pub fn render_a2ui_tool(catalog: Option<&Catalog>) -> ToolDefinition {
    let component_type = match catalog {
        Some(catalog) if !catalog.components.is_empty() => json!({
            "type": "string",
            "description": "The component type, from the catalog.",
            "enum": catalog
                .components_in_order()
                .map(|d| d.name.clone())
                .collect::<Vec<_>>()
        }),
        _ => json!({
            "type": "string",
            "description": "The component type, e.g. 'Text' or 'Column'."
        }),
    };

    ToolDefinition {
        name: RENDER_A2UI_TOOL_NAME,
        description: format!(
            "Emit the UI surface as a flat list of A2UI components. Components are never nested: \
             a parent names its children by id. Exactly one component must have id '{ROOT_ID}', \
             and it must come first, with every parent listed before its children."
        ),
        parameters: json!({
            "type": "object",
            "properties": {
                "components": {
                    "type": "array",
                    "minItems": 1,
                    "description": format!(
                        "The flat component list. The first entry must be the '{ROOT_ID}' \
                         component; parents come before their children."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": format!(
                                    "Unique id within this surface. Exactly one component uses \
                                     '{ROOT_ID}'."
                                )
                            },
                            "component": component_type
                        },
                        "required": ["id", "component"],
                        "additionalProperties": true
                    }
                },
                "data_model": {
                    "type": "object",
                    "description": "Data the components bind to. Every {\"path\": \"/pointer\"} \
                                    binding in the components must resolve here.",
                    "additionalProperties": true
                },
                "message": {
                    "type": "string",
                    "description": "Optional short sentence to show the user alongside the \
                                    surface."
                }
            },
            "required": ["components"]
        }),
    }
}

/// Both tool definitions, planner-facing first.
pub fn tool_definitions(catalog: Option<&Catalog>) -> Vec<ToolDefinition> {
    vec![generate_a2ui_tool(), render_a2ui_tool(catalog)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_names_are_the_wire_constants() {
        assert_eq!(generate_a2ui_tool().name, "generate_a2ui");
        assert_eq!(render_a2ui_tool(None).name, "render_a2ui");
    }

    #[test]
    fn the_planner_tool_forces_an_explicit_intent() {
        let tool = generate_a2ui_tool();
        let intent = &tool.parameters["properties"]["intent"];
        assert_eq!(intent["enum"], json!(["create", "update"]));
        assert_eq!(tool.parameters["required"], json!(["intent", "request"]));
        assert!(tool.description.contains("never re-creates"));
    }

    #[test]
    fn the_render_tool_states_the_adjacency_rules() {
        let tool = render_a2ui_tool(None);
        assert!(tool.description.contains("never nested"));
        assert!(tool.description.contains("'root'"));
        assert_eq!(
            tool.parameters["properties"]["components"]["items"]["required"],
            json!(["id", "component"])
        );
        assert_eq!(tool.parameters["properties"]["components"]["minItems"], 1);
    }

    #[test]
    fn a_catalog_constrains_the_component_enum() {
        let catalog = Catalog::basic();
        let tool = render_a2ui_tool(Some(&catalog));
        let types = &tool.parameters["properties"]["components"]["items"]["properties"]["component"]
            ["enum"];
        assert_eq!(types[0], "Text");
        assert_eq!(types.as_array().unwrap().len(), 18);

        // No catalog means no enum, so custom catalogs are not blocked.
        let open = render_a2ui_tool(None);
        assert!(
            open.parameters["properties"]["components"]["items"]["properties"]["component"]["enum"]
                .is_null()
        );
        assert!(render_a2ui_tool(Some(&Catalog::empty("x"))).parameters["properties"]
            ["components"]["items"]["properties"]["component"]["enum"]
            .is_null());
    }

    #[test]
    fn definitions_render_for_an_api_payload() {
        let value = generate_a2ui_tool().to_anthropic_value();
        assert_eq!(value["name"], "generate_a2ui");
        assert_eq!(value["input_schema"]["type"], "object");
        assert_eq!(tool_definitions(None).len(), 2);
    }
}
