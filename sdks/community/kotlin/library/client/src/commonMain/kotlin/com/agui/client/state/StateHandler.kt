package com.agui.client.state

import kotlinx.serialization.json.*

/**
 * Interface for handling state changes in the AG-UI client.
 */
interface StateChangeHandler {
    /**
     * Called when the state is replaced with a snapshot.
     */
    suspend fun onStateSnapshot(snapshot: JsonElement) {}

    /**
     * Called when the state is updated with a delta (JSON Patch operations).
     */
    suspend fun onStateDelta(delta: JsonArray) {}

    /**
     * Called when a state update fails.
     */
    suspend fun onStateError(error: Throwable, delta: JsonArray?) {}
}

/**
 * Creates a state change handler using lambda functions.
 */
fun stateHandler(
    onSnapshot: suspend (JsonElement) -> Unit = {},
    onDelta: suspend (JsonArray) -> Unit = {},
    onError: suspend (Throwable, JsonArray?) -> Unit = { _, _ -> }
): StateChangeHandler = object : StateChangeHandler {
    override suspend fun onStateSnapshot(snapshot: JsonElement) = onSnapshot(snapshot)
    override suspend fun onStateDelta(delta: JsonArray) = onDelta(delta)
    override suspend fun onStateError(error: Throwable, delta: JsonArray?) = onError(error, delta)
}

/**
 * A composite state handler that delegates to multiple handlers.
 */
class CompositeStateHandler(
    internal val handlers: List<StateChangeHandler>
) : StateChangeHandler {

    constructor(vararg handlers: StateChangeHandler) : this(handlers.toList())

    override suspend fun onStateSnapshot(snapshot: JsonElement) {
        handlers.forEach { it.onStateSnapshot(snapshot) }
    }

    override suspend fun onStateDelta(delta: JsonArray) {
        handlers.forEach { it.onStateDelta(delta) }
    }

    override suspend fun onStateError(error: Throwable, delta: JsonArray?) {
        handlers.forEach { it.onStateError(error, delta) }
    }
}

/**
 * Extension function to combine state handlers.
 */
operator fun StateChangeHandler.plus(other: StateChangeHandler): StateChangeHandler {
    return when {
        this is CompositeStateHandler && other is CompositeStateHandler ->
            CompositeStateHandler(this.handlers + other.handlers)
        this is CompositeStateHandler ->
            CompositeStateHandler(this.handlers + other)
        other is CompositeStateHandler ->
            CompositeStateHandler(listOf(this) + other.handlers)
        else ->
            CompositeStateHandler(this, other)
    }
}