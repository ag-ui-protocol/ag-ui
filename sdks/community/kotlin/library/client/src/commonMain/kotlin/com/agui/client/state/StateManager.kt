package com.agui.client.state

import co.touchlab.kermit.Logger
import com.agui.client.jsonpatch.JsonPatch
import com.agui.core.types.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

private val logger = Logger.withTag("StateManager")

/**
 * Manages client-side state with JSON Patch support.
 * Uses a vendored JsonPatch implementation derived from io.github.reidsync:kotlin-json-patch.
 * Provides reactive state management with StateFlow and handles both
 * full state snapshots and incremental JSON Patch deltas.
 * 
 * @property handler Optional callback handler for state change notifications
 * @param initialState The initial state as a JsonElement (defaults to empty JsonObject)
 */
class StateManager(
    private val handler: StateChangeHandler? = null,
    initialState: JsonElement = JsonObject(emptyMap())
) {
    private val _currentState = MutableStateFlow(initialState)
    val currentState: StateFlow<JsonElement> = _currentState.asStateFlow()

    /**
     * Processes AG-UI events and updates state.
     * Handles StateSnapshotEvent and StateDeltaEvent to maintain current state.
     * Other event types are ignored as they don't affect state.
     * 
     * @param event The AG-UI event to process
     */
    suspend fun processEvent(event: BaseEvent) {
        when (event) {
            is StateSnapshotEvent -> applySnapshot(event.snapshot)
            is StateDeltaEvent -> applyDelta(event.delta)
            else -> {} // Other events don't affect state
        }
    }

    private suspend fun applySnapshot(snapshot: JsonElement) {
        logger.d { "Applying state snapshot" }
        _currentState.value = snapshot
        handler?.onStateSnapshot(snapshot)
    }

    private suspend fun applyDelta(delta: JsonArray) {
        logger.d { "Applying ${delta.size} state operations" }

        try {
            val newState = JsonPatch.apply(delta, currentState.value)
            _currentState.value = newState
            handler?.onStateDelta(delta)
        } catch (e: Exception) {
            logger.e(e) { "Failed to apply state delta" }
            handler?.onStateError(e, delta)
        }
    }

    /**
     * Gets a value by JSON Pointer path.
     * 
     * @param path JSON Pointer path (e.g., "/user/name" or "/items/0")
     * @return JsonElement? the value at the specified path, or null if not found or on error
     */
    fun getValue(path: String): JsonElement? {
        return try {
            JsonPointer.evaluate(currentState.value, path)
        } catch (e: Exception) {
            logger.e(e) { "Failed to get value at: $path" }
            null
        }
    }

    /**
     * Gets a typed value by path.
     */
    private inline fun <reified T> getValueAs(path: String): T? {
        val element = getValue(path) ?: return null
        return try {
            Json.decodeFromJsonElement(element) // Assuming you have a Json instance
        } catch (e: Exception) {
            logger.e(e) { "Failed to decode value at: $path" }
            null
        }
    }
}
