package com.agui.a2ui.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Represents a user interaction event from an A2UI surface.
 *
 * Events are generated when users interact with UI components
 * (button clicks, form submissions, etc.) and can be sent back
 * to the AI agent for processing.
 */
sealed class UiEvent {
    /**
     * The surface ID where the event originated.
     */
    abstract val surfaceId: String
}

/**
 * A user action event triggered by interaction (e.g., button click).
 *
 * Matches the A2UI ClientEvent format expected by agents:
 * ```json
 * {
 *   "name": "action_name",
 *   "surfaceId": "default",
 *   "sourceComponentId": "component-id:item1",
 *   "timestamp": "2025-12-17T02:00:23.936Z",
 *   "context": { ... }
 * }
 * ```
 *
 * @property name The action identifier (at root level, not nested)
 * @property surfaceId The surface where the action occurred
 * @property sourceComponentId The component ID with optional template item suffix
 * @property timestamp ISO8601 timestamp of when the event occurred
 * @property context Resolved context data from action.context bindings
 */
@Serializable
data class UserActionEvent(
    val name: String,
    override val surfaceId: String,
    val sourceComponentId: String,
    val timestamp: String,
    val context: JsonObject? = null
) : UiEvent()

/**
 * A data change event when the user modifies a bound value.
 *
 * @property surfaceId The surface where the change occurred
 * @property path The data model path that was modified
 * @property value The new value
 */
@Serializable
data class DataChangeEvent(
    override val surfaceId: String,
    val path: String,
    val value: String
) : UiEvent()
