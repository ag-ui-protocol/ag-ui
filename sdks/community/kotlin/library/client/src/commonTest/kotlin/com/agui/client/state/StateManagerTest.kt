package com.agui.client.state

import com.agui.core.types.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

class StateManagerTest {

    @Test
    fun testStateSnapshot() = runTest {
        var snapshotReceived: JsonElement? = null

        val stateManager = StateManager(
            handler = stateHandler(
                onSnapshot = { snapshot ->
                    snapshotReceived = snapshot
                }
            )
        )

        val snapshot = buildJsonObject {
            put("user", "john")
            put("count", 42)
        }

        stateManager.processEvent(StateSnapshotEvent(snapshot))

        assertEquals(snapshot, snapshotReceived)
        assertEquals(snapshot, stateManager.currentState.value)
    }

    @Test
    fun testStateDelta() = runTest {
        val initialState = buildJsonObject {
            put("user", "john")
            put("count", 42)
            putJsonObject("nested") {
                put("value", "test")
            }
            putJsonArray("items") {
                add("item1")
                add("item2")
            }
        }

        val stateManager = StateManager(initialState = initialState)

        // Test comprehensive patch operations: add, replace, remove, copy, move, test
        val delta = buildJsonArray {
            // Add operation - add new field
            addJsonObject {
                put("op", "add")
                put("path", "/newField")
                put("value", "newValue")
            }
            // Replace operation - modify existing field
            addJsonObject {
                put("op", "replace")
                put("path", "/count")
                put("value", 43)
            }
            // Add operation - add to nested object
            addJsonObject {
                put("op", "add")
                put("path", "/nested/newProp")
                put("value", true)
            }
            // Add operation - add to array
            addJsonObject {
                put("op", "add")
                put("path", "/items/2")
                put("value", "item3")
            }
            // Replace operation - modify nested property
            addJsonObject {
                put("op", "replace")
                put("path", "/nested/value")
                put("value", "updated_test")
            }
        }

        stateManager.processEvent(StateDeltaEvent(delta))

        val newState = stateManager.currentState.value.jsonObject

        // Verify all patch operations worked correctly
        assertEquals("john", newState["user"]?.jsonPrimitive?.content)
        assertEquals(43, newState["count"]?.jsonPrimitive?.int)
        assertEquals("newValue", newState["newField"]?.jsonPrimitive?.content)

        val nested = newState["nested"]?.jsonObject
        assertNotNull(nested)
        assertEquals("updated_test", nested["value"]?.jsonPrimitive?.content)
        assertEquals(true, nested["newProp"]?.jsonPrimitive?.boolean)

        val items = newState["items"]?.jsonArray
        assertNotNull(items)
        assertEquals(3, items.size)
        assertEquals("item1", items[0].jsonPrimitive.content)
        assertEquals("item2", items[1].jsonPrimitive.content)
        assertEquals("item3", items[2].jsonPrimitive.content)
    }

    @Test
    fun testStateDeltaRemoveOperation() = runTest {
        val initialState = buildJsonObject {
            put("user", "john")
            put("count", 42)
            put("tempField", "toBeRemoved")
        }

        val stateManager = StateManager(initialState = initialState)

        // Test remove operation
        val delta = buildJsonArray {
            addJsonObject {
                put("op", "remove")
                put("path", "/tempField")
            }
        }

        stateManager.processEvent(StateDeltaEvent(delta))

        val newState = stateManager.currentState.value.jsonObject

        // Verify remove operation worked
        assertEquals("john", newState["user"]?.jsonPrimitive?.content)
        assertEquals(42, newState["count"]?.jsonPrimitive?.int)
        assertNull(newState["tempField"])
    }

    @Test
    fun testGetValue() = runTest {
        val state = buildJsonObject {
            put("user", "john")
            putJsonObject("profile") {
                put("age", 30)
                putJsonArray("tags") {
                    add("kotlin")
                    add("android")
                }
            }
        }

        val stateManager = StateManager(initialState = state)

        // Test various paths
        assertEquals("john", stateManager.getValue("/user")?.jsonPrimitive?.content)
        assertEquals(30, stateManager.getValue("/profile/age")?.jsonPrimitive?.int)
        assertEquals("kotlin", stateManager.getValue("/profile/tags/0")?.jsonPrimitive?.content)
        assertEquals("android", stateManager.getValue("/profile/tags/1")?.jsonPrimitive?.content)

        // Test non-existent paths
        assertNull(stateManager.getValue("/nonexistent"))
        assertNull(stateManager.getValue("/profile/tags/5"))
    }

    @Test
    fun testFailedDeltaPreservesStateAndRecovers() = runTest {
        val errors = mutableListOf<Pair<Throwable, JsonArray?>>()
        val deltas = mutableListOf<JsonArray>()
        val initialState = json("""{"a":1}""")
        val stateManager = StateManager(
            handler = stateHandler(
                onDelta = { deltas += it },
                onError = { error, delta -> errors += error to delta }
            ),
            initialState = initialState
        )

        // The first operation succeeds on its own, but the patch is applied atomically.
        val failing = patch("""[{"op":"add","path":"/b","value":2},{"op":"remove","path":"/missing"}]""")
        stateManager.processEvent(StateDeltaEvent(failing))

        assertEquals(initialState, stateManager.currentState.value)
        assertEquals(1, errors.size)
        assertIs<JsonPatchApplicationException>(errors.single().first)
        assertEquals(failing, errors.single().second)
        assertTrue(deltas.isEmpty())

        stateManager.processEvent(StateDeltaEvent(patch("""[{"op":"add","path":"/b","value":2}]""")))

        assertEquals(json("""{"a":1,"b":2}"""), stateManager.currentState.value)
        assertEquals(1, errors.size)
        assertEquals(1, deltas.size)
    }

    @Test
    fun testInvalidDeltasAreRejected() = runTest {
        // Each delta violates RFC 6902 (or RFC 6901 pointer syntax) and must leave the state untouched.
        val invalid = listOf(
            """[{"op":"replace","path":"/missing","value":2}]""",
            """[{"op":"remove","path":"/missing"}]""",
            """[{"op":"add","path":"/missing/child","value":2}]""",
            """[{"op":"add","path":"/items/01","value":2}]""",
            """[{"op":"add","path":"/b"}]""",
            """[{"op":"move","from":"/nested","path":"/nested/child"}]""",
            """[{"op":"remove","path":""}]""",
            """[{"op":"frobnicate","path":"/a","value":2}]""",
            """[{"op":"replace","path":"a","value":2}]""",
        )
        val initialState = json("""{"a":1,"items":[1,2],"nested":{"x":1}}""")

        for (delta in invalid) {
            var error: Throwable? = null
            val stateManager = StateManager(
                handler = stateHandler(onError = { e, _ -> error = e }),
                initialState = initialState
            )

            stateManager.processEvent(StateDeltaEvent(patch(delta)))

            assertNotNull(error, "expected $delta to fail")
            assertEquals(initialState, stateManager.currentState.value, "state changed by $delta")
        }
    }

    @Test
    fun testNumericTestOperationComparesValues() = runTest {
        val stateManager = StateManager(initialState = json("""{"a":1}"""))

        stateManager.processEvent(
            StateDeltaEvent(patch("""[{"op":"test","path":"/a","value":1.0},{"op":"add","path":"/b","value":2}]"""))
        )

        assertEquals(json("""{"a":1,"b":2}"""), stateManager.currentState.value)
    }

    private fun json(value: String): JsonElement = Json.parseToJsonElement(value)

    private fun patch(value: String): JsonArray = json(value).jsonArray
}
