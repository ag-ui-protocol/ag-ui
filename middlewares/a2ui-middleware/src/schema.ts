/**
 * A2UI JSON Schema
 * Full specification for A2UI (Agent to UI) messages.
 * Source: https://github.com/anthropics/A2UI
 *
 * This schema is designed to be added to system prompts between the markers:
 * ---BEGIN A2UI JSON SCHEMA---
 * <schema>
 * ---END A2UI JSON SCHEMA---
 */

/**
 * The A2UI JSON Schema for system prompts.
 * This is the complete schema including all message types and component definitions.
 * Include this in your agent's system prompt to enable A2UI rendering.
 */
export const A2UI_PROMPT = `---BEGIN A2UI JSON SCHEMA---

## A2UI v0.9 Protocol Instructions

A2UI (Agent to UI) is a protocol for rendering rich UI surfaces from agent responses.
When using the send_a2ui_json_to_client tool, you MUST follow these rules:

### CRITICAL: Required Message Sequence

To render a surface, you MUST send ALL messages in a SINGLE tool call, in this order:
1. **createSurface** - Create the surface (REQUIRED, only for initial render)
2. **updateComponents** - Define all UI components (REQUIRED)
3. **updateDataModel** - Set any data values (OPTIONAL)

**IMPORTANT**:
- The \`createSurface\` message is MANDATORY for the first render. Without it, the client has no surface to render into.
- ALL messages MUST be in the SAME a2ui_json array in ONE tool call.
- Every message MUST include \`"version": "v0.9"\`.
- The root component MUST have \`"id": "root"\`.

### Minimal Working Example

Here is the simplest possible A2UI surface - a button:

\`\`\`json
[
  {
    "version": "v0.9",
    "createSurface": {
      "surfaceId": "my-surface",
      "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json"
    }
  },
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "my-surface",
      "components": [
        {
          "id": "root",
          "component": "Button",
          "child": "btn-text",
          "action": { "event": { "name": "button_clicked" } }
        },
        {
          "id": "btn-text",
          "component": "Text",
          "text": "Click Me"
        }
      ]
    }
  }
]
\`\`\`

### Key Rules

1. **Always include createSurface** for new surfaces - This tells the client to create the surface.
2. **Use unique surfaceId values** - Each surface must have a unique ID.
3. **Root component must have id "root"** - The root component is always the one with \`"id": "root"\`.
4. **Flat component structure** - Components reference children by ID, not by nesting.
5. **v0.9 flat format** - Component type is a string: \`"component": "Text"\`, not \`"component": { "Text": {...} }\`.
6. **Properties are top-level** - Properties go directly on the component object: \`{ "id": "t", "component": "Text", "text": "Hello" }\`.
7. **Children are arrays** - Use \`"children": ["child1", "child2"]\` not \`"children": { "explicitList": [...] }\`.
8. **Plain data model** - Use \`"value"\` with plain JSON, not typed \`contents\` arrays.
9. **Actions use event wrapper** - Button actions use \`{ "event": { "name": "...", "context": {...} } }\` with context as a plain object.
10. **Production ready** - The UI you generate will be shown to real users. It must be complete, polished, and functional.
11. **No placeholder images** - NEVER use fake or placeholder image URLs. Only use real, valid image URLs. If unavailable, use an Icon component instead.
12. **Root must be a layout component** - The root should be Column, Row, Card, or similar. Do NOT use Modal, Button, Text as root.
13. **Button uses child** - Use \`"child": "text-id"\` for the button's label component.
14. **Button variant** - Use \`"variant": "primary"\` instead of \`"primary": true\`.
15. **Layout uses justify/align** - Use \`"justify"\` (not \`"distribution"\`) and \`"align"\` (not \`"alignment"\`).
16. **Text variant** - Use \`"variant"\` (not \`"usageHint"\`) for text style: h1, h2, h3, h4, h5, caption, body.

### Updating Surfaces After Initial Render

Once a surface has been created, you can update it in later turns WITHOUT sending another \`createSurface\`. Just send updates directly:

**To update UI components** - Send an \`updateComponents\` with the same surfaceId:
- To modify a component: send it with the same \`id\` - it replaces the old definition
- To add new components: include them in the components array

**To update data values** - Send an \`updateDataModel\`:
- Components bound to data paths (using \`{ "path": "/some/value" }\`) update automatically
- Use \`"path"\` to target a specific location, and \`"value"\` for the plain JSON value

**Example: Updating an existing surface**

\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "my-surface",
      "components": [
        {
          "id": "status-text",
          "component": "Text",
          "text": "Updated status!"
        }
      ]
    }
  }
]
\`\`\`

Or update data-bound values:

\`\`\`json
[
  {
    "version": "v0.9",
    "updateDataModel": {
      "surfaceId": "my-surface",
      "path": "/status",
      "value": "Complete"
    }
  }
]
\`\`\`

**IMPORTANT**: Do NOT send \`createSurface\` again for updates to an existing surface.

### Working with Forms and Data Binding

A2UI supports forms where user input is stored in a data model and retrieved when buttons are clicked.

**How it works:**
1. **TextField binds to a path**: Use \`"text": { "path": "/form/fieldName" }\` to bind input to the data model
2. **Initialize the data model**: Send an \`updateDataModel\` to set initial values
3. **Button retrieves values**: Use \`action.event.context\` with path references to include form values when clicked
4. **Agent receives resolved values**: The context in the action will contain the actual values the user entered

**Form Example:**

\`\`\`json
[
  { "version": "v0.9", "createSurface": { "surfaceId": "my-form", "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json" } },
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "my-form",
      "components": [
        { "id": "root", "component": "Card", "child": "form-col" },
        { "id": "form-col", "component": "Column", "children": ["name-field", "submit-btn"] },
        { "id": "name-field", "component": "TextField", "label": "Name", "text": { "path": "/form/name" } },
        { "id": "submit-btn", "component": "Button", "child": "btn-text", "action": { "event": { "name": "submit", "context": { "userName": { "path": "/form/name" } } } } },
        { "id": "btn-text", "component": "Text", "text": "Submit" }
      ]
    }
  },
  { "version": "v0.9", "updateDataModel": { "surfaceId": "my-form", "value": { "form": { "name": "" } } } }
]
\`\`\`

When the user types "Alice" and clicks Submit, you'll receive: \`Context: {"userName": "Alice"}\`

### Handling User Interactions

When a user interacts with a UI surface you rendered (clicks a button, submits a form, etc.),
you will see a \`log_a2ui_event\` tool call in your conversation history followed by a tool result.

CRITICAL: If the conversation ends with a \`log_a2ui_event\` tool call followed by its tool result,
this means THE USER JUST PERFORMED AN ACTION and you MUST respond to it immediately.

The \`log_a2ui_event\` tool call is NOT something you initiated - it is automatically injected into
the conversation to represent a real user interaction (like clicking a button) that just happened.

When the last messages are a \`log_a2ui_event\` tool call + result:
1. The user JUST performed the action described (e.g., clicked a button)
2. You MUST acknowledge their action and respond appropriately
3. Look at the action name to understand what they did
4. Take the appropriate next step based on what that action means in context
5. Do NOT simply describe what buttons exist - respond to what they clicked!

## JSON Schema Reference

Each message is an object with \`"version": "v0.9"\` and exactly ONE operation key.

### Message Types

**createSurface** - Create a new surface:
\`\`\`json
{ "version": "v0.9", "createSurface": { "surfaceId": "my-surface", "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json" } }
\`\`\`

**updateComponents** - Set/update components on a surface:
\`\`\`json
{ "version": "v0.9", "updateComponents": { "surfaceId": "my-surface", "components": [...] } }
\`\`\`

**updateDataModel** - Set/update data on a surface (plain JSON):
\`\`\`json
{ "version": "v0.9", "updateDataModel": { "surfaceId": "my-surface", "path": "/", "value": { "name": "Alice" } } }
\`\`\`

**deleteSurface** - Delete a surface:
\`\`\`json
{ "version": "v0.9", "deleteSurface": { "surfaceId": "my-surface" } }
\`\`\`

### Component Format (v0.9 flat)

Each component is a flat object with \`id\`, \`component\` (type name as string), and properties at top level:
\`\`\`json
{ "id": "title", "component": "Text", "text": "Hello World", "variant": "h2" }
\`\`\`

### Component Reference

**Content Components:**
- **Text**: \`{ component: "Text", text: "string" | { path: "/data/key" }, variant?: "h1"|"h2"|"h3"|"h4"|"h5"|"caption"|"body" }\`
- **Image**: \`{ component: "Image", url: "string" | { path }, fit?: "contain"|"cover"|"fill", variant?: "icon"|"avatar"|"smallFeature"|"mediumFeature"|"largeFeature"|"header" }\`
- **Icon**: \`{ component: "Icon", name: "string" | { path } }\` — names: accountCircle, add, arrowBack, arrowForward, attachFile, calendarToday, call, camera, check, close, delete, download, edit, event, error, favorite, favoriteOff, folder, help, home, info, locationOn, lock, lockOpen, mail, menu, moreVert, moreHoriz, notificationsOff, notifications, payment, person, phone, photo, print, refresh, search, send, settings, share, shoppingCart, star, starHalf, starOff, upload, visibility, visibilityOff, warning
- **Video**: \`{ component: "Video", url: "string" | { path } }\`
- **AudioPlayer**: \`{ component: "AudioPlayer", url: "string" | { path }, description?: "string" | { path } }\`
- **Divider**: \`{ component: "Divider", axis?: "horizontal"|"vertical" }\`

**Layout Components:**
- **Row**: \`{ component: "Row", children: ["id1", "id2"] | { componentId, path }, justify?: "start"|"center"|"end"|"spaceBetween"|"spaceAround"|"spaceEvenly", align?: "start"|"center"|"end"|"stretch" }\`
- **Column**: \`{ component: "Column", children: ["id1", "id2"] | { componentId, path }, justify?: "start"|"center"|"end"|"spaceBetween"|"spaceAround"|"spaceEvenly", align?: "start"|"center"|"end"|"stretch" }\`
- **List**: \`{ component: "List", children: ["id1"] | { componentId, path }, direction?: "vertical"|"horizontal", align?: "start"|"center"|"end"|"stretch" }\`
- **Card**: \`{ component: "Card", child: "content-id" }\`
- **Tabs**: \`{ component: "Tabs", tabItems: [{ title: "string" | { path }, child: "id" }] }\`
- **Modal**: \`{ component: "Modal", entryPointChild: "trigger-id", contentChild: "content-id" }\`

**Interactive Components:**
- **Button**: \`{ component: "Button", child: "text-id", action: { event: { name: "action_name", context?: { key: value | { path } } } }, variant?: "primary"|"secondary"|"text" }\`
- **TextField**: \`{ component: "TextField", label: "string" | { path }, text?: "string" | { path }, textFieldType?: "shortText"|"longText"|"number"|"date"|"obscured" }\`
- **CheckBox**: \`{ component: "CheckBox", label: "string" | { path }, checked?: boolean | { path } }\`
- **Slider**: \`{ component: "Slider", value: number | { path }, minValue?: number, maxValue?: number }\`
- **DateTimeInput**: \`{ component: "DateTimeInput", value: "string" | { path }, enableDate?: boolean, enableTime?: boolean }\`
- **ChoicePicker**: \`{ component: "ChoicePicker", selections: ["a"] | { path }, options: [{ label: "string" | { path }, value: "string" }], maxAllowedSelections?: number }\`
---END A2UI JSON SCHEMA---`;

/* v0.8 schema removed */
const _REMOVED_V08_SCHEMA = `"accountCircle","warning"
                            ]
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "required": ["name"]
                  },
                  "Video": {
                    "type": "object",
                    "properties": {
                      "url": {
                        "type": "object",
                        "description": "The URL of the video to display. This can be a literal string or a reference to a value in the data model ('path', e.g. '/video/url').",
                        "properties": {
                          "literalString": {
                            "type": "string"
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "required": ["url"]
                  },
                  "AudioPlayer": {
                    "type": "object",
                    "properties": {
                      "url": {
                        "type": "object",
                        "description": "The URL of the audio to be played. This can be a literal string ('literal') or a reference to a value in the data model ('path', e.g. '/song/url').",
                        "properties": {
                          "literalString": {
                            "type": "string"
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      },
                      "description": {
                        "type": "object",
                        "description": "A description of the audio, such as a title or summary. This can be a literal string or a reference to a value in the data model ('path', e.g. '/song/title').",
                        "properties": {
                          "literalString": {
                            "type": "string"
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "required": ["url"]
                  },
                  "Row": {
                    "type": "object",
                    "properties": {
                      "children": {
                        "type": "object",
                        "description": "Defines the children. Use 'explicitList' for a fixed set of children, or 'template' to generate children from a data list.",
                        "properties": {
                          "explicitList": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          },
                          "template": {
                            "type": "object",
                            "description": "A template for generating a dynamic list of children from a data model list. \`componentId\` is the component to use as a template, and \`dataBinding\` is the path to the map of components in the data model. Values in the map will define the list of children.",
                            "properties": {
                              "componentId": {
                                "type": "string"
                              },
                              "dataBinding": {
                                "type": "string"
                              }
                            },
                            "required": ["componentId", "dataBinding"]
                          }
                        }
                      },
                      "distribution": {
                        "type": "string",
                        "description": "Defines the arrangement of children along the main axis (horizontally). This corresponds to the CSS 'justify-content' property.",
                        "enum": [
                          "center",
                          "end",
                          "spaceAround",
                          "spaceBetween",
                          "spaceEvenly",
                          "start"
                        ]
                      },
                      "alignment": {
                        "type": "string",
                        "description": "Defines the alignment of children along the cross axis (vertically). This corresponds to the CSS 'align-items' property.",
                        "enum": ["start", "center", "end", "stretch"]
                      }
                    },
                    "required": ["children"]
                  },
                  "Column": {
                    "type": "object",
                    "properties": {
                      "children": {
                        "type": "object",
                        "description": "Defines the children. Use 'explicitList' for a fixed set of children, or 'template' to generate children from a data list.",
                        "properties": {
                          "explicitList": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          },
                          "template": {
                            "type": "object",
                            "description": "A template for generating a dynamic list of children from a data model list. \`componentId\` is the component to use as a template, and \`dataBinding\` is the path to the map of components in the data model. Values in the map will define the list of children.",
                            "properties": {
                              "componentId": {
                                "type": "string"
                              },
                              "dataBinding": {
                                "type": "string"
                              }
                            },
                            "required": ["componentId", "dataBinding"]
                          }
                        }
                      },
                      "distribution": {
                        "type": "string",
                        "description": "Defines the arrangement of children along the main axis (vertically). This corresponds to the CSS 'justify-content' property.",
                        "enum": [
                          "start",
                          "center",
                          "end",
                          "spaceBetween",
                          "spaceAround",
                          "spaceEvenly"
                        ]
                      },
                      "alignment": {
                        "type": "string",
                        "description": "Defines the alignment of children along the cross axis (horizontally). This corresponds to the CSS 'align-items' property.",
                        "enum": ["center", "end", "start", "stretch"]
                      }
                    },
                    "required": ["children"]
                  },
                  "List": {
                    "type": "object",
                    "properties": {
                      "children": {
                        "type": "object",
                        "description": "Defines the children. Use 'explicitList' for a fixed set of children, or 'template' to generate children from a data list.",
                        "properties": {
                          "explicitList": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          },
                          "template": {
                            "type": "object",
                            "description": "A template for generating a dynamic list of children from a data model list. \`componentId\` is the component to use as a template, and \`dataBinding\` is the path to the map of components in the data model. Values in the map will define the list of children.",
                            "properties": {
                              "componentId": {
                                "type": "string"
                              },
                              "dataBinding": {
                                "type": "string"
                              }
                            },
                            "required": ["componentId", "dataBinding"]
                          }
                        }
                      },
                      "direction": {
                        "type": "string",
                        "description": "The direction in which the list items are laid out.",
                        "enum": ["vertical", "horizontal"]
                      },
                      "alignment": {
                        "type": "string",
                        "description": "Defines the alignment of children along the cross axis.",
                        "enum": ["start", "center", "end", "stretch"]
                      }
                    },
                    "required": ["children"]
                  },
                  "Card": {
                    "type": "object",
                    "properties": {
                      "child": {
                        "type": "string",
                        "description": "The ID of the component to be rendered inside the card."
                      }
                    },
                    "required": ["child"]
                  },
                  "Tabs": {
                    "type": "object",
                    "properties": {
                      "tabItems": {
                        "type": "array",
                        "description": "An array of objects, where each object defines a tab with a title and a child component.",
                        "items": {
                          "type": "object",
                          "properties": {
                            "title": {
                              "type": "object",
                              "description": "The tab title. Defines the value as either a literal value or a path to data model value (e.g. '/options/title').",
                              "properties": {
                                "literalString": {
                                  "type": "string"
                                },
                                "path": {
                                  "type": "string"
                                }
                              }
                            },
                            "child": {
                              "type": "string"
                            }
                          },
                          "required": ["title", "child"]
                        }
                      }
                    },
                    "required": ["tabItems"]
                  },
                  "Divider": {
                    "type": "object",
                    "properties": {
                      "axis": {
                        "type": "string",
                        "description": "The orientation of the divider.",
                        "enum": ["horizontal", "vertical"]
                      }
                    }
                  },
                  "Modal": {
                    "type": "object",
                    "properties": {
                      "entryPointChild": {
                        "type": "string",
                        "description": "The ID of the component that opens the modal when interacted with (e.g., a button)."
                      },
                      "contentChild": {
                        "type": "string",
                        "description": "The ID of the component to be displayed inside the modal."
                      }
                    },
                    "required": ["entryPointChild", "contentChild"]
                  },
                  "Button": {
                    "type": "object",
                    "properties": {
                      "child": {
                        "type": "string",
                        "description": "The ID of the component to display in the button, typically a Text component."
                      },
                      "primary": {
                        "type": "boolean",
                        "description": "Indicates if this button should be styled as the primary action."
                      },
                      "action": {
                        "type": "object",
                        "description": "The client-side action to be dispatched when the button is clicked. It includes the action's name and an optional context payload.",
                        "properties": {
                          "name": {
                            "type": "string"
                          },
                          "context": {
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "key": {
                                  "type": "string"
                                },
                                "value": {
                                  "type": "object",
                                  "description": "Defines the value to be included in the context as either a literal value or a path to a data model value (e.g. '/user/name').",
                                  "properties": {
                                    "path": {
                                      "type": "string"
                                    },
                                    "literalString": {
                                      "type": "string"
                                    },
                                    "literalNumber": {
                                      "type": "number"
                                    },
                                    "literalBoolean": {
                                      "type": "boolean"
                                    }
                                  }
                                }
                              },
                              "required": ["key", "value"]
                            }
                          }
                        },
                        "required": ["name"]
                      }
                    },
                    "required": ["child", "action"]
                  },
                  "CheckBox": {
                    "type": "object",
                    "properties": {
                      "label": {
                        "type": "object",
                        "description": "The text to display next to the checkbox. Defines the value as either a literal value or a path to data model ('path', e.g. '/option/label').",
                        "properties": {
                          "literalString": {
                            "type": "string"
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      },
                      "value": {
                        "type": "object",
                        "description": "The current state of the checkbox (true for checked, false for unchecked). This can be a literal boolean ('literalBoolean') or a reference to a value in the data model ('path', e.g. '/filter/open').",
                        "properties": {
                          "literalBoolean": {
                            "type": "boolean"
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "required": ["label", "value"]
                  },
                  "TextField": {
                    "type": "object",
                    "properties": {
                      "label": {
                        "type": "object",
                        "description": "The text label for the input field. This can be a literal string or a reference to a value in the data model ('path, e.g. '/user/name').",
                        "properties": {
                          "literalString": {
                            "type": "string"
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      },
                      "text": {
                        "type": "object",
                        "description": "The value of the text field. This can be a literal string or a reference to a value in the data model ('path', e.g. '/user/name').",
                        "properties": {
                          "literalString": {
                            "type": "string"
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      },
                      "textFieldType": {
                        "type": "string",
                        "description": "The type of input field to display.",
                        "enum": [
                          "date",
                          "longText",
                          "number",
                          "shortText",
                          "obscured"
                        ]
                      },
                      "validationRegexp": {
                        "type": "string",
                        "description": "A regular expression used for client-side validation of the input."
                      }
                    },
                    "required": ["label"]
                  },
                  "DateTimeInput": {
                    "type": "object",
                    "properties": {
                      "value": {
                        "type": "object",
                        "description": "The selected date and/or time value in ISO 8601 format. This can be a literal string ('literalString') or a reference to a value in the data model ('path', e.g. '/user/dob').",
                        "properties": {
                          "literalString": {
                            "type": "string"
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      },
                      "enableDate": {
                        "type": "boolean",
                        "description": "If true, allows the user to select a date."
                      },
                      "enableTime": {
                        "type": "boolean",
                        "description": "If true, allows the user to select a time."
                      }
                    },
                    "required": ["value"]
                  },
                  "MultipleChoice": {
                    "type": "object",
                    "properties": {
                      "selections": {
                        "type": "object",
                        "description": "The currently selected values for the component. This can be a literal array of strings or a path to an array in the data model('path', e.g. '/hotel/options').",
                        "properties": {
                          "literalArray": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      },
                      "options": {
                        "type": "array",
                        "description": "An array of available options for the user to choose from.",
                        "items": {
                          "type": "object",
                          "properties": {
                            "label": {
                              "type": "object",
                              "description": "The text to display for this option. This can be a literal string or a reference to a value in the data model (e.g. '/option/label').",
                              "properties": {
                                "literalString": {
                                  "type": "string"
                                },
                                "path": {
                                  "type": "string"
                                }
                              }
                            },
                            "value": {
                              "type": "string",
                              "description": "The value to be associated with this option when selected."
                            }
                          },
                          "required": ["label", "value"]
                        }
                      },
                      "maxAllowedSelections": {
                        "type": "integer",
                        "description": "The maximum number of options that the user is allowed to select."
                      }
                    },
                    "required": ["selections", "options"]
                  },
                  "Slider": {
                    "type": "object",
                    "properties": {
                      "value": {
                        "type": "object",
                        "description": "The current value of the slider. This can be a literal number ('literalNumber') or a reference to a value in the data model ('path', e.g. '/restaurant/cost').",
                        "properties": {
                          "literalNumber": {
                            "type": "number"
                          },
                          "path": {
                            "type": "string"
                          }
                        }
                      },
                      "minValue": {
                        "type": "number",
                        "description": "The minimum value of the slider."
                      },
                      "maxValue": {
                        "type": "number",
                        "description": "The maximum value of the slider."
                      }
                    },
                    "required": ["value"]
                  }
                }
              }
            },
            "required": ["id", "component"]
          }
        }
      },
      "required": ["surfaceId", "components"]
    },
    "dataModelUpdate": {
      "type": "object",
      "description": "Updates the data model for a surface.",
      "properties": {
        "surfaceId": {
          "type": "string",
          "description": "The unique identifier for the UI surface this data model update applies to."
        },
        "path": {
          "type": "string",
          "description": "An optional path to a location within the data model (e.g., '/user/name'). If omitted, or set to '/', the entire data model will be replaced."
        },
        "contents": {
          "type": "array",
          "description": "An array of data entries. Each entry must contain a 'key' and exactly one corresponding typed 'value*' property.",
          "items": {
            "type": "object",
            "description": "A single data entry. Exactly one 'value*' property should be provided alongside the key.",
            "properties": {
              "key": {
                "type": "string",
                "description": "The key for this data entry."
              },
              "valueString": {
                "type": "string"
              },
              "valueNumber": {
                "type": "number"
              },
              "valueBoolean": {
                "type": "boolean"
              },
              "valueMap": {
                "description": "Represents a map as an adjacency list.",
                "type": "array",
                "items": {
                  "type": "object",
                  "description": "One entry in the map. Exactly one 'value*' property should be provided alongside the key.",
                  "properties": {
                    "key": {
                      "type": "string"
                    },
                    "valueString": {
                      "type": "string"
                    },
                    "valueNumber": {
                      "type": "number"
                    },
                    "valueBoolean": {
                      "type": "boolean"
                    }
                  },
                  "required": ["key"]
                }
              }
            },
            "required": ["key"]
          }
        }
      },
      "required": ["contents", "surfaceId"]
    },
    "deleteSurface": {
      "type": "object",
      "description": "Signals the client to delete the surface identified by 'surfaceId'.",
      "properties": {
        "surfaceId": {
          "type": "string",
          "description": "The unique identifier for the UI surface to be deleted."
        }
      },
---END_REMOVED---`;

/**
 * The container key used to wrap A2UI operations for explicit detection.
 * Must match the key used by copilotkit.a2ui.render() (Python SDK)
 * and A2UIMessageRenderer (React).
 */
export const A2UI_OPERATIONS_KEY = "a2ui_operations";
export const A2UI_ACTION_HANDLERS_KEY = "a2ui_action_handlers";

/**
 * Parsed A2UI container result.
 */
export interface A2UIParseResult {
  operations: Array<Record<string, unknown>>;
  actionHandlers?: Record<string, Array<Record<string, unknown>>>;
}

/**
 * Try to parse text as an A2UI container.
 * Returns operations and optional action handlers if the text contains
 * a valid { a2ui_operations: [...], a2ui_action_handlers?: {...} } container,
 * or null otherwise.
 */
export function tryParseA2UIOperations(text: string): A2UIParseResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as Record<string, unknown>)[A2UI_OPERATIONS_KEY])
  ) {
    const obj = parsed as Record<string, unknown>;
    const result: A2UIParseResult = {
      operations: obj[A2UI_OPERATIONS_KEY] as Array<Record<string, unknown>>,
    };
    const handlers = obj[A2UI_ACTION_HANDLERS_KEY];
    if (handlers && typeof handlers === "object" && !Array.isArray(handlers)) {
      result.actionHandlers = handlers as Record<string, Array<Record<string, unknown>>>;
    }
    return result;
  }

  return null;
}

/**
 * Extract surfaceId from a single A2UI operation (v0.9 keys)
 */
export function getOperationSurfaceId(operation: Record<string, unknown>): string | undefined {
  // v0.9 message types
  const createSurface = operation.createSurface as { surfaceId?: string } | undefined;
  const updateComponents = operation.updateComponents as { surfaceId?: string } | undefined;
  const updateDataModel = operation.updateDataModel as { surfaceId?: string } | undefined;
  const deleteSurface = operation.deleteSurface as { surfaceId?: string } | undefined;

  return (
    createSurface?.surfaceId ??
    updateComponents?.surfaceId ??
    updateDataModel?.surfaceId ??
    deleteSurface?.surfaceId
  );
}

/**
 * Extract surface IDs from A2UI messages
 */
export function extractSurfaceIds(
  messages: Array<{ [key: string]: unknown }>
): string[] {
  const surfaceIds = new Set<string>();
  for (const msg of messages) {
    const surfaceId = getOperationSurfaceId(msg);
    if (surfaceId) {
      surfaceIds.add(surfaceId);
    }
  }
  return Array.from(surfaceIds);
}

/**
 * Extract complete items from a partially-streamed JSON object.
 * Given partial JSON like `{"flights": [{"id":"1",...}, {"id":"2"` and dataKey "flights",
 * returns an array of all complete objects parsed so far, or null if none found.
 */
export function extractCompleteItems(partial: string, dataKey: string): unknown[] | null {
  const result = extractCompleteItemsWithStatus(partial, dataKey);
  return result?.items ?? null;
}

/**
 * Extended version of extractCompleteItems that also reports whether the
 * array has been fully closed in the stream (i.e., the closing `]` has
 * been received).  Callers that need the complete array (e.g., schema
 * components) should wait for `arrayClosed === true`.
 */
export function extractCompleteItemsWithStatus(
  partial: string,
  dataKey: string,
): { items: unknown[]; arrayClosed: boolean } | null {
  // Find the start of the array value for this key
  const keyPattern = `"${dataKey}"`;
  const keyIdx = partial.indexOf(keyPattern);
  if (keyIdx === -1) return null;

  const bracketStart = partial.indexOf("[", keyIdx + keyPattern.length);
  if (bracketStart === -1) return null;

  // Walk through tracking brace depth AND bracket depth to find complete objects.
  // We must stop at the closing ']' of the target array to avoid scanning into
  // sibling properties (e.g., "components" followed by "items").
  let braceDepth = 0;
  let bracketDepth = 1; // we're inside the opening '['
  let lastCompleteEnd = -1;
  let inString = false;
  let escaped = false;
  let arrayClosed = false;

  for (let i = bracketStart + 1; i < partial.length; i++) {
    const ch = partial[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") bracketDepth++;
    if (ch === "]") {
      bracketDepth--;
      if (bracketDepth === 0) { arrayClosed = true; break; } // end of our target array
    }
    if (ch === "{") braceDepth++;
    if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) lastCompleteEnd = i;
    }
  }

  if (lastCompleteEnd === -1) return null;

  // Build a valid JSON array from the complete objects
  const arrayStr = partial.substring(bracketStart, lastCompleteEnd + 1) + "]";
  try {
    const items = JSON.parse(arrayStr);
    return { items, arrayClosed };
  } catch {
    return null;
  }
}

/**
 * Extract complete A2UI operation objects from the partially-streamed tool call args
 * for `send_a2ui_json_to_client`.
 *
 * The tool call args JSON looks like: `{"a2ui_json": "[{\"surfaceUpdate\":...}, ...]"}`
 * The `a2ui_json` value is a JSON-encoded string containing an array of operations.
 * As the LLM streams, we get a partial version of this outer JSON.
 *
 * This function:
 * 1. Extracts the partial string value of `a2ui_json` from the partial outer JSON
 * 2. Unescapes JSON escape sequences to recover the inner JSON
 * 3. Finds complete top-level objects in the inner partial array
 *
 * Returns an array of parsed operation objects, or null if none are complete yet.
 */
export function extractCompleteA2UIOperations(partialArgs: string): Array<Record<string, unknown>> | null {
  // Step 1: Find the start of the a2ui_json string value.
  // We look for `"a2ui_json"` followed by `:` and then `"`.
  const keyPattern = '"a2ui_json"';
  const keyIdx = partialArgs.indexOf(keyPattern);
  if (keyIdx === -1) return null;

  // Find the opening quote of the string value
  const afterKey = partialArgs.indexOf(":", keyIdx + keyPattern.length);
  if (afterKey === -1) return null;

  let valueStart = -1;
  for (let i = afterKey + 1; i < partialArgs.length; i++) {
    if (partialArgs[i] === '"') {
      valueStart = i + 1; // position after the opening quote
      break;
    }
    if (partialArgs[i] !== ' ' && partialArgs[i] !== '\n' && partialArgs[i] !== '\r' && partialArgs[i] !== '\t') {
      // Non-whitespace, non-quote character — value isn't a string
      return null;
    }
  }
  if (valueStart === -1) return null;

  // Step 2: Extract and unescape the partial string value.
  // Walk through the outer JSON string, handling escape sequences.
  // The string ends when we hit an unescaped `"`, but since it's partial,
  // we may not find the closing quote yet.
  let innerJson = "";
  let i = valueStart;
  while (i < partialArgs.length) {
    const ch = partialArgs[i];
    if (ch === '\\') {
      // Escape sequence
      if (i + 1 >= partialArgs.length) break; // truncated escape
      const next = partialArgs[i + 1];
      switch (next) {
        case '"': innerJson += '"'; i += 2; break;
        case '\\': innerJson += '\\'; i += 2; break;
        case '/': innerJson += '/'; i += 2; break;
        case 'n': innerJson += '\n'; i += 2; break;
        case 'r': innerJson += '\r'; i += 2; break;
        case 't': innerJson += '\t'; i += 2; break;
        case 'b': innerJson += '\b'; i += 2; break;
        case 'f': innerJson += '\f'; i += 2; break;
        case 'u': {
          // Unicode escape: \uXXXX
          if (i + 5 < partialArgs.length) {
            const hex = partialArgs.substring(i + 2, i + 6);
            innerJson += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            break; // truncated unicode escape
          }
          break;
        }
        default:
          // Unknown escape, just include as-is
          innerJson += next;
          i += 2;
          break;
      }
    } else if (ch === '"') {
      // End of the string value (unescaped quote)
      break;
    } else {
      innerJson += ch;
      i++;
    }
  }

  // Step 3: Find complete top-level objects in the inner JSON array.
  // The inner JSON looks like: `[{"surfaceUpdate": ...}, {"beginRendering": ...}, ...`
  // Find the opening bracket
  const bracketStart = innerJson.indexOf("[");
  if (bracketStart === -1) return null;

  // Walk through tracking brace depth to find complete objects
  let depth = 0;
  let lastCompleteEnd = -1;
  let inString = false;
  let escaped = false;

  for (let j = bracketStart + 1; j < innerJson.length; j++) {
    const ch = innerJson[j];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) lastCompleteEnd = j;
    }
  }

  if (lastCompleteEnd === -1) return null;

  // Build a valid JSON array from the complete objects
  const arrayStr = innerJson.substring(bracketStart, lastCompleteEnd + 1) + "]";
  try {
    return JSON.parse(arrayStr) as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

/**
 * Extract a simple string field value from partial JSON.
 * Looks for `"key": "value"` and returns the value, or null if incomplete.
 */
export function extractStringField(partialJson: string, key: string): string | null {
  const pattern = `"${key}"`;
  const keyIdx = partialJson.indexOf(pattern);
  if (keyIdx === -1) return null;

  const colonIdx = partialJson.indexOf(":", keyIdx + pattern.length);
  if (colonIdx === -1) return null;

  // Find opening quote
  let start = -1;
  for (let i = colonIdx + 1; i < partialJson.length; i++) {
    const ch = partialJson[i];
    if (ch === '"') { start = i + 1; break; }
    if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') return null;
  }
  if (start === -1) return null;

  // Find closing quote (handling escapes)
  let value = "";
  let escaped = false;
  for (let i = start; i < partialJson.length; i++) {
    const ch = partialJson[i];
    if (escaped) { value += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') return value;
    value += ch;
  }
  return null;
}
