package com.agui.a2ui.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Tests for A2UI ClientEvent format.
 *
 * Per the A2UI protocol, ClientEvents sent to the agent must have this structure:
 * ```json
 * {
 *   "name": "action_name",
 *   "surfaceId": "default",
 *   "sourceComponentId": "component-id:item1",
 *   "timestamp": "2025-12-17T02:00:23.936Z",
 *   "context": { "key": "value", ... }
 * }
 * ```
 */
class ClientEventFormatTest {

    @Test
    fun `UserActionEvent has name at root level`() {
        val event = UserActionEvent(
            name = "book_restaurant",
            surfaceId = "default",
            sourceComponentId = "template-book-button:item1",
            timestamp = "2025-12-17T02:00:23.936Z",
            context = null
        )

        assertEquals("book_restaurant", event.name)
    }

    @Test
    fun `UserActionEvent has sourceComponentId with item suffix`() {
        val event = UserActionEvent(
            name = "book_restaurant",
            surfaceId = "default",
            sourceComponentId = "template-book-button:item1",
            timestamp = "2025-12-17T02:00:23.936Z",
            context = null
        )

        assertEquals("template-book-button:item1", event.sourceComponentId)
        assertTrue(event.sourceComponentId.contains(":"))
    }

    @Test
    fun `UserActionEvent has timestamp in ISO8601 format`() {
        val event = UserActionEvent(
            name = "submit_form",
            surfaceId = "default",
            sourceComponentId = "submit-button",
            timestamp = "2025-12-17T02:00:23.936Z",
            context = null
        )

        assertTrue(event.timestamp.matches(Regex("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d+Z")))
    }

    @Test
    fun `UserActionEvent context contains resolved data`() {
        val context = buildJsonObject {
            put("restaurantName", "Xi'an Famous Foods")
            put("imageUrl", "http://localhost:10002/static/food.jpeg")
            put("address", "81 St Marks Pl, New York, NY 10003")
        }

        val event = UserActionEvent(
            name = "book_restaurant",
            surfaceId = "default",
            sourceComponentId = "template-book-button:item1",
            timestamp = "2025-12-17T02:00:23.936Z",
            context = context
        )

        assertNotNull(event.context)
        assertEquals("Xi'an Famous Foods", (event.context!!["restaurantName"] as JsonPrimitive).content)
    }

    @Test
    fun `UserActionEvent surfaceId should not be empty`() {
        val event = UserActionEvent(
            name = "click",
            surfaceId = "default",
            sourceComponentId = "my-button",
            timestamp = "2025-12-17T00:00:00.000Z",
            context = null
        )

        assertTrue(event.surfaceId.isNotEmpty())
        assertEquals("default", event.surfaceId)
    }
}
