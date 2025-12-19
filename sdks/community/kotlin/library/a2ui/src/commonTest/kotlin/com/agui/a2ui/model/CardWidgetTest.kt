package com.agui.a2ui.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * Tests for CardWidget JSON parsing.
 *
 * The Card widget in A2UI:
 * - Takes a `child` property referencing another component
 * - Applies internal padding (8dp) around the child (matching Flutter GenUI)
 * - Uses surface color from the theme
 */
class CardWidgetTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `parseComponentRef extracts child component reference`() {
        val jsonStr = """
            {
                "child": "card-content"
            }
        """.trimIndent()

        val data = json.decodeFromString<JsonObject>(jsonStr)
        val childRef = DataReferenceParser.parseComponentRef(data["child"])

        assertNotNull(childRef)
        assertEquals("card-content", childRef.componentId)
    }

    @Test
    fun `card with nested layout structure`() {
        // This matches the restaurant app structure:
        // Card -> Row -> [Image, Column]
        val jsonStr = """
            {
                "child": "card-layout"
            }
        """.trimIndent()

        val data = json.decodeFromString<JsonObject>(jsonStr)
        val childRef = DataReferenceParser.parseComponentRef(data["child"])

        assertNotNull(childRef)
        assertEquals("card-layout", childRef.componentId)
    }
}
