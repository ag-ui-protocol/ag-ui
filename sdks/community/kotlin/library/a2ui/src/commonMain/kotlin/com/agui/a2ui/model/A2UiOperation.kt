package com.agui.a2ui.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull

/**
 * Represents an A2UI operation that modifies the surface state.
 *
 * Operations are received via ACTIVITY_SNAPSHOT/DELTA events and processed
 * by [SurfaceStateManager] to build [UiDefinition] instances.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
sealed class A2UiOperation

/**
 * Initializes a new surface for rendering.
 *
 * @property surfaceId Unique identifier for the surface
 * @property root The ID of the root component
 * @property styles Optional styling configuration for the surface
 */
@Serializable
@SerialName("beginRendering")
data class BeginRendering(
    val surfaceId: String,
    val root: String,
    val styles: JsonObject? = null
) : A2UiOperation()

/**
 * Updates components in a surface.
 *
 * @property surfaceId The surface to update
 * @property components List of component definitions to add or update
 */
@Serializable
@SerialName("surfaceUpdate")
data class SurfaceUpdate(
    val surfaceId: String,
    val components: List<ComponentDef>
) : A2UiOperation()

/**
 * Updates the data model for a surface.
 *
 * @property surfaceId The surface whose data model to update
 * @property path JSON Pointer path in the data model
 * @property contents List of data entries to set at the path
 */
@Serializable
@SerialName("dataModelUpdate")
data class DataModelUpdate(
    val surfaceId: String,
    val path: String,
    val contents: List<DataEntry>
) : A2UiOperation()

/**
 * Deletes a surface and all its state.
 *
 * @property surfaceId The surface to delete
 */
@Serializable
@SerialName("deleteSurface")
data class DeleteSurface(
    val surfaceId: String
) : A2UiOperation()

/**
 * A component definition in v0.9 schema format.
 *
 * The component type is stored in [component] and all widget-specific
 * properties are flattened into [properties].
 *
 * Example JSON:
 * ```json
 * {
 *   "id": "title",
 *   "component": "Text",
 *   "text": { "literalString": "Hello World" },
 *   "usageHint": { "literalString": "h1" }
 * }
 * ```
 */
@Serializable
data class ComponentDef(
    val id: String,
    val component: String,
    /**
     * Additional properties are captured here during deserialization.
     * This allows the component to have arbitrary widget-specific properties.
     */
    val properties: JsonObject = JsonObject(emptyMap()),
    /**
     * Optional flex weight for layout containers (at component level, not in properties).
     */
    val weight: Int? = null
) {
    companion object {
        /**
         * Creates a ComponentDef from a raw JsonObject.
         *
         * Parses v0.8 format where component is an object:
         * ```json
         * {
         *   "id": "my-id",
         *   "component": {
         *     "Column": { "children": { "explicitList": ["child1"] } }
         *   }
         * }
         * ```
         */
        fun fromJson(json: JsonObject): ComponentDef {
            val id = json["id"]?.let {
                (it as? kotlinx.serialization.json.JsonPrimitive)?.content
            } ?: error("Component missing 'id'")

            val componentObj = json["component"]?.let {
                it as? JsonObject
            } ?: error("Component missing 'component' object")

            // v0.8: component is {"WidgetType": {props}}
            val widgetType = componentObj.keys.firstOrNull()
                ?: error("Component object is empty")
            val properties = componentObj[widgetType] as? JsonObject
                ?: JsonObject(emptyMap())

            // Extract weight from top level (not inside component properties)
            val weight = json["weight"]?.let {
                (it as? kotlinx.serialization.json.JsonPrimitive)?.intOrNull
            }

            return ComponentDef(
                id = id,
                component = widgetType,
                properties = properties,
                weight = weight
            )
        }
    }
}

/**
 * A data entry for updating the data model.
 *
 * Supports multiple value types matching the A2UI protocol:
 * - valueString: String values
 * - valueNumber: Numeric values
 * - valueBool: Boolean values
 * - valueMap: Nested object (list of key-value pairs that becomes a JsonObject)
 * - valueJson: Raw JSON
 */
@Serializable
data class DataEntry(
    val key: String,
    val valueString: String? = null,
    val valueNumber: Double? = null,
    val valueBoolean: Boolean? = null,
    val valueMap: List<DataEntry>? = null,
    val valueJson: JsonElement? = null
) {
    /**
     * Returns the value as a JsonElement for storage in the data model.
     */
    fun toJsonElement(): JsonElement {
        return when {
            valueString != null -> kotlinx.serialization.json.JsonPrimitive(valueString)
            valueNumber != null -> kotlinx.serialization.json.JsonPrimitive(valueNumber)
            valueBoolean != null -> kotlinx.serialization.json.JsonPrimitive(valueBoolean)
            valueMap != null -> {
                // Convert list of DataEntry to JsonObject
                val map = valueMap.associate { entry ->
                    entry.key to entry.toJsonElement()
                }
                JsonObject(map)
            }
            valueJson != null -> valueJson
            else -> kotlinx.serialization.json.JsonNull
        }
    }
}

/**
 * Container for A2UI operations in an ACTIVITY_SNAPSHOT event.
 */
@Serializable
data class A2UiActivityContent(
    val operations: List<JsonObject> = emptyList()
)
