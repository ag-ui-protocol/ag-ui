package com.agui.a2ui.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Represents a UI component in the A2UI protocol (v0.8 format).
 *
 * v0.8 format:
 * ```json
 * {
 *   "id": "button_1",
 *   "component": {
 *     "Button": { "child": "text_1" }
 *   }
 * }
 * ```
 *
 * @property id Unique identifier for this component within its surface
 * @property componentProperties Legacy format - Map with widget type as key (deprecated)
 * @property component Widget type name (e.g., "Button", "Column", "Text")
 * @property properties Widget-specific properties
 * @property weight Optional flex weight for layout containers
 */
@Serializable
data class Component(
    val id: String,
    val componentProperties: Map<String, JsonObject> = emptyMap(),
    val component: String? = null,
    val properties: JsonObject = JsonObject(emptyMap()),
    val weight: Int? = null
) {
    /**
     * Returns the widget type name (e.g., "Text", "Button", "Column").
     * Supports both v0.8 (componentProperties) and v0.9 (component) schemas.
     */
    val widgetType: String?
        get() = component ?: componentProperties.keys.firstOrNull()

    /**
     * Returns the widget configuration data.
     * For v0.8: returns the value from componentProperties
     * For v0.9: returns the flattened properties
     */
    val widgetData: JsonObject?
        get() = when {
            component != null -> properties
            else -> componentProperties.values.firstOrNull()
        }

    companion object {
        /**
         * Creates a Component from a ComponentDef.
         */
        fun fromComponentDef(def: ComponentDef): Component {
            return Component(
                id = def.id,
                component = def.component,
                properties = def.properties,
                weight = def.weight
            )
        }

        /**
         * Creates a Component using v0.8 schema.
         */
        fun v08(id: String, widgetType: String, data: JsonObject, weight: Int? = null): Component {
            return Component(
                id = id,
                componentProperties = mapOf(widgetType to data),
                weight = weight
            )
        }

        /**
         * Creates a Component using v0.9 schema.
         */
        fun v09(id: String, widgetType: String, properties: JsonObject, weight: Int? = null): Component {
            return Component(
                id = id,
                component = widgetType,
                properties = properties,
                weight = weight
            )
        }
    }
}
