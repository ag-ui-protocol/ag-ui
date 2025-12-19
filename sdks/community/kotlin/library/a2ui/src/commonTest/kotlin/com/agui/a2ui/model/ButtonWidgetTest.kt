package com.agui.a2ui.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Tests for ButtonWidget JSON parsing.
 *
 * The Button widget in A2UI uses a `child` property that references
 * another component (typically Text) rather than a direct label.
 * This matches the Flutter GenUI Button schema.
 */
class ButtonWidgetTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `parseString extracts child component reference`() {
        val jsonStr = """
            {
                "child": "book-now-text",
                "primary": true,
                "action": {
                    "name": "book_restaurant"
                }
            }
        """.trimIndent()

        val data = json.decodeFromString<JsonObject>(jsonStr)
        val childRef = DataReferenceParser.parseString(data["child"])

        assertNotNull(childRef)
        assertEquals("book-now-text", (childRef as LiteralString).value)
    }

    @Test
    fun `parseBoolean extracts primary property`() {
        val jsonStr = """
            {
                "child": "button-text",
                "primary": true
            }
        """.trimIndent()

        val data = json.decodeFromString<JsonObject>(jsonStr)
        val primaryRef = DataReferenceParser.parseBoolean(data["primary"])

        assertNotNull(primaryRef)
        assertEquals(true, (primaryRef as LiteralBoolean).value)
    }

    @Test
    fun `parseBoolean returns null when primary is missing`() {
        val jsonStr = """
            {
                "child": "button-text"
            }
        """.trimIndent()

        val data = json.decodeFromString<JsonObject>(jsonStr)
        val primaryRef = DataReferenceParser.parseBoolean(data["primary"])

        assertNull(primaryRef)
    }

    @Test
    fun `action schema parses name correctly`() {
        val jsonStr = """
            {
                "child": "submit-text",
                "action": {
                    "name": "submit_form",
                    "context": [
                        {"key": "formId", "value": {"literalString": "contact-form"}}
                    ]
                }
            }
        """.trimIndent()

        val data = json.decodeFromString<JsonObject>(jsonStr)
        val action = data["action"] as? JsonObject

        assertNotNull(action)
        assertEquals("submit_form", action["name"]?.let {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.content
        })
    }

    @Test
    fun `action context with literal values parses correctly`() {
        val jsonStr = """
            {
                "child": "book-text",
                "action": {
                    "name": "book_restaurant",
                    "context": [
                        {"key": "restaurantId", "value": {"literalString": "rest-123"}},
                        {"key": "guests", "value": {"literalNumber": 4}},
                        {"key": "confirmed", "value": {"literalBoolean": true}}
                    ]
                }
            }
        """.trimIndent()

        val data = json.decodeFromString<JsonObject>(jsonStr)
        val action = data["action"] as? JsonObject
        val context = action?.get("context") as? kotlinx.serialization.json.JsonArray

        assertNotNull(context)
        assertEquals(3, context.size)

        // First context entry
        val first = context[0] as JsonObject
        assertEquals("restaurantId", first["key"]?.let {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.content
        })
    }

    @Test
    fun `action context with path bindings parses correctly`() {
        // This matches the restaurant app button format
        val jsonStr = """
            {
                "child": "book-now-text",
                "primary": true,
                "action": {
                    "name": "book_restaurant",
                    "context": [
                        {"key": "restaurantName", "value": {"path": "name"}},
                        {"key": "imageUrl", "value": {"path": "imageUrl"}},
                        {"key": "address", "value": {"path": "address"}}
                    ]
                }
            }
        """.trimIndent()

        val data = json.decodeFromString<JsonObject>(jsonStr)
        val action = data["action"] as? JsonObject
        val context = action?.get("context") as? kotlinx.serialization.json.JsonArray

        assertNotNull(context)
        assertEquals(3, context.size)

        // Verify path binding structure
        val first = context[0] as JsonObject
        assertEquals("restaurantName", first["key"]?.let {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.content
        })
        val value = first["value"] as? JsonObject
        assertNotNull(value)
        assertEquals("name", value["path"]?.let {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.content
        })
    }

    @Test
    fun `fallback label property is supported for backwards compatibility`() {
        // Some implementations may use "label" directly instead of "child"
        val jsonStr = """
            {
                "label": {"literalString": "Click Me"}
            }
        """.trimIndent()

        val data = json.decodeFromString<JsonObject>(jsonStr)
        val labelRef = DataReferenceParser.parseString(data["label"])

        assertNotNull(labelRef)
        assertEquals("Click Me", (labelRef as LiteralString).value)
    }
}
