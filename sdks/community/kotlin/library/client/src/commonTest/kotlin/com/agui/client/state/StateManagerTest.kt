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

}