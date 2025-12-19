package com.agui.a2ui.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Tests for ComponentDef parsing from JSON.
 *
 * These tests ensure that component definitions are correctly parsed,
 * including top-level properties like 'weight' that exist alongside
 * the nested component properties.
 */
class ComponentDefTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `fromJson extracts id and component type`() {
        val jsonStr = """
            {
                "id": "my-button",
                "component": {
                    "Button": { "child": "button-text" }
                }
            }
        """.trimIndent()

        val jsonObj = json.decodeFromString<JsonObject>(jsonStr)
        val def = ComponentDef.fromJson(jsonObj)

        assertEquals("my-button", def.id)
        assertEquals("Button", def.component)
    }

    @Test
    fun `fromJson extracts weight from top level`() {
        val jsonStr = """
            {
                "id": "template-image",
                "weight": 1,
                "component": {
                    "Image": { "url": { "path": "imageUrl" } }
                }
            }
        """.trimIndent()

        val jsonObj = json.decodeFromString<JsonObject>(jsonStr)
        val def = ComponentDef.fromJson(jsonObj)

        assertEquals("template-image", def.id)
        assertEquals("Image", def.component)
        assertEquals(1, def.weight)
    }

    @Test
    fun `fromJson extracts larger weight values`() {
        val jsonStr = """
            {
                "id": "card-details",
                "weight": 2,
                "component": {
                    "Column": { "children": { "explicitList": ["title", "subtitle"] } }
                }
            }
        """.trimIndent()

        val jsonObj = json.decodeFromString<JsonObject>(jsonStr)
        val def = ComponentDef.fromJson(jsonObj)

        assertEquals("card-details", def.id)
        assertEquals("Column", def.component)
        assertEquals(2, def.weight)
    }

    @Test
    fun `fromJson handles missing weight as null`() {
        val jsonStr = """
            {
                "id": "simple-text",
                "component": {
                    "Text": { "text": { "literalString": "Hello" } }
                }
            }
        """.trimIndent()

        val jsonObj = json.decodeFromString<JsonObject>(jsonStr)
        val def = ComponentDef.fromJson(jsonObj)

        assertEquals("simple-text", def.id)
        assertEquals("Text", def.component)
        assertNull(def.weight)
    }

    @Test
    fun `fromJson extracts widget properties`() {
        val jsonStr = """
            {
                "id": "my-text",
                "component": {
                    "Text": {
                        "text": { "literalString": "Hello World" },
                        "usageHint": { "literalString": "h1" }
                    }
                }
            }
        """.trimIndent()

        val jsonObj = json.decodeFromString<JsonObject>(jsonStr)
        val def = ComponentDef.fromJson(jsonObj)

        assertEquals("my-text", def.id)
        assertEquals("Text", def.component)
        assertNotNull(def.properties["text"])
        assertNotNull(def.properties["usageHint"])
    }

    @Test
    fun `Component fromComponentDef preserves weight`() {
        val jsonStr = """
            {
                "id": "weighted-image",
                "weight": 3,
                "component": {
                    "Image": { "url": { "literalString": "https://example.com/img.jpg" } }
                }
            }
        """.trimIndent()

        val jsonObj = json.decodeFromString<JsonObject>(jsonStr)
        val def = ComponentDef.fromJson(jsonObj)
        val component = Component.fromComponentDef(def)

        assertEquals("weighted-image", component.id)
        assertEquals("Image", component.widgetType)
        assertEquals(3, component.weight)
    }

    @Test
    fun `Component fromComponentDef handles null weight`() {
        val jsonStr = """
            {
                "id": "no-weight",
                "component": {
                    "Text": { "text": { "literalString": "No weight" } }
                }
            }
        """.trimIndent()

        val jsonObj = json.decodeFromString<JsonObject>(jsonStr)
        val def = ComponentDef.fromJson(jsonObj)
        val component = Component.fromComponentDef(def)

        assertEquals("no-weight", component.id)
        assertEquals("Text", component.widgetType)
        assertNull(component.weight)
    }
}
