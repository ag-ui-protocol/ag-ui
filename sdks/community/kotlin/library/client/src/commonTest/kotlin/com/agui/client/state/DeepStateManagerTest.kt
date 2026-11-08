package com.agui.client.state

import com.agui.core.types.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * StateManager publication for state nested far deeper than a call stack can recurse. Nothing
 * here compares or prints a whole document, because JsonElement's equals and toString recurse.
 *
 * The depth follows DeepStateDeltaTest (100,000): the 4,096 depth from the #3318 reproduction
 * sits at the overflow edge — with -Xss1m it overflows cold but can pass once the JIT inlines
 * the equality frames — so the regression test uses a depth that overflows deterministically on
 * the old publication path. The bounded JVM check in #3318 used OpenJDK 17 with -Xss1m,
 * Kotlin 2.1.21, coroutines 1.10.2 and serialization 1.8.1.
 */
class DeepStateManagerTest {
    private val depth = 100_000

    private fun nestedObjects(levels: Int = depth, leaf: JsonElement = JsonPrimitive(0)): JsonElement {
        var document = leaf
        repeat(levels) { document = JsonObject(mapOf("a" to document)) }
        return document
    }

    private fun nestedArrays(levels: Int = depth, leaf: JsonElement = JsonPrimitive(0)): JsonElement {
        var document = leaf
        repeat(levels) { document = JsonArray(listOf(document)) }
        return document
    }

    private fun objectLeaf(document: JsonElement, levels: Int = depth): JsonElement? {
        var current: JsonElement? = document
        repeat(levels) { current = (current as? JsonObject)?.get("a") }
        return current
    }

    private fun arrayLeaf(document: JsonElement, levels: Int = depth): JsonElement? {
        var current: JsonElement? = document
        repeat(levels) { current = (current as? JsonArray)?.get(0) }
        return current
    }

    private fun patch(op: String, path: String, value: JsonElement? = null): JsonArray =
        buildJsonArray {
            add(buildJsonObject {
                put("op", op)
                put("path", path)
                value?.let { put("value", it) }
            })
        }

    @Test
    fun publishesADeepLeafReplacement() = runTest {
        val leafPath = "/a".repeat(depth)
        var applied = 0
        var errors = 0
        val manager = StateManager(
            handler = stateHandler(
                onDelta = { applied++ },
                onError = { _, _ -> errors++ }
            ),
            initialState = nestedObjects()
        )
        val delta = patch("replace", leafPath, JsonPrimitive(1))

        manager.processEvent(StateDeltaEvent(delta))

        assertEquals(JsonPrimitive(1), objectLeaf(manager.currentState.value))
        assertEquals(1, applied)
        assertEquals(0, errors)
    }

    @Test
    fun snapshotPublishesDeepStateToCollectors() = runTest {
        var snapshots = 0
        val manager = StateManager(
            handler = stateHandler(onSnapshot = { snapshots++ }),
            initialState = nestedObjects()
        )
        val emitted = mutableListOf<JsonElement>()
        backgroundScope.launch { manager.currentState.collect { emitted += it } }
        runCurrent()

        manager.processEvent(StateSnapshotEvent(nestedObjects(leaf = JsonPrimitive(1))))
        runCurrent()

        assertEquals(2, emitted.size)
        assertEquals(JsonPrimitive(0), objectLeaf(emitted[0]))
        assertEquals(JsonPrimitive(1), objectLeaf(emitted[1]))
        assertEquals(1, snapshots)
    }

    @Test
    fun equalDeepSnapshotDoesNotEmitAgain() = runTest {
        var snapshots = 0
        val manager = StateManager(
            handler = stateHandler(onSnapshot = { snapshots++ }),
            initialState = nestedObjects()
        )
        val emitted = mutableListOf<JsonElement>()
        backgroundScope.launch { manager.currentState.collect { emitted += it } }
        runCurrent()

        // A separately built document with identical content: StateFlow conflation must hold.
        manager.processEvent(StateSnapshotEvent(nestedObjects()))
        runCurrent()

        assertEquals(1, emitted.size)
        assertEquals(JsonPrimitive(0), objectLeaf(emitted.single()))
        assertEquals(1, snapshots)
    }

    @Test
    fun equalDeepDeltaDoesNotEmitAgain() = runTest {
        val leafPath = "/a".repeat(depth)
        var applied = 0
        var errors = 0
        val manager = StateManager(
            handler = stateHandler(
                onDelta = { applied++ },
                onError = { _, _ -> errors++ }
            ),
            initialState = nestedObjects()
        )
        val emitted = mutableListOf<JsonElement>()
        backgroundScope.launch { manager.currentState.collect { emitted += it } }
        runCurrent()

        // Replacing the leaf with the value it already holds leaves the state unchanged.
        manager.processEvent(StateDeltaEvent(patch("replace", leafPath, JsonPrimitive(0))))
        runCurrent()

        assertEquals(1, emitted.size)
        assertEquals(JsonPrimitive(0), objectLeaf(emitted.single()))
        assertEquals(1, applied)
        assertEquals(0, errors)
    }

    @Test
    fun publishesADeepArrayLeafReplacement() = runTest {
        val leafPath = "/0".repeat(depth)
        var applied = 0
        var errors = 0
        val manager = StateManager(
            handler = stateHandler(
                onDelta = { applied++ },
                onError = { _, _ -> errors++ }
            ),
            initialState = nestedArrays()
        )

        manager.processEvent(StateDeltaEvent(patch("replace", leafPath, JsonPrimitive(1))))

        assertEquals(JsonPrimitive(1), arrayLeaf(manager.currentState.value))
        assertEquals(1, applied)
        assertEquals(0, errors)
    }

    @Test
    fun equalDeepArraySnapshotDoesNotEmitAgain() = runTest {
        var snapshots = 0
        val manager = StateManager(
            handler = stateHandler(onSnapshot = { snapshots++ }),
            initialState = nestedArrays()
        )
        val emitted = mutableListOf<JsonElement>()
        backgroundScope.launch { manager.currentState.collect { emitted += it } }
        runCurrent()

        manager.processEvent(StateSnapshotEvent(nestedArrays()))
        runCurrent()

        assertEquals(1, emitted.size)
        assertEquals(JsonPrimitive(0), arrayLeaf(emitted.single()))
        assertEquals(1, snapshots)
    }

    @Test
    fun deepDeltaStillReachesCollectors() = runTest {
        val leafPath = "/a".repeat(depth)
        val manager = StateManager(initialState = nestedObjects())
        val emitted = mutableListOf<JsonElement>()
        backgroundScope.launch { manager.currentState.collect { emitted += it } }
        runCurrent()

        manager.processEvent(StateDeltaEvent(patch("replace", leafPath, JsonPrimitive(1))))
        runCurrent()

        assertEquals(2, emitted.size)
        assertEquals(JsonPrimitive(1), objectLeaf(emitted.last()))
        assertTrue(emitted.first() !== emitted.last())
    }
}
