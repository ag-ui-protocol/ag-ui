package com.agui.a2ui.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * Represents a reference to data in the A2UI protocol.
 *
 * Data references can be either:
 * - Literal values: `{"literalString": "Hello"}` or `{"literalNumber": 42}`
 * - Path-based bindings: `{"path": "/user/name"}` (binds to DataModel)
 *
 * This sealed class hierarchy provides type-safe access to referenced data.
 */
sealed class DataReference<T> {
    /**
     * Gets the value, either as a literal or by resolving a path.
     * For path references, requires a resolver function.
     */
    abstract fun resolve(pathResolver: (String) -> T?): T?
}

/**
 * A literal string value.
 */
data class LiteralString(val value: String) : DataReference<String>() {
    override fun resolve(pathResolver: (String) -> String?): String = value
}

/**
 * A string value bound to a data model path.
 */
data class PathString(val path: String) : DataReference<String>() {
    override fun resolve(pathResolver: (String) -> String?): String? = pathResolver(path)
}

/**
 * A literal number value.
 */
data class LiteralNumber(val value: Double) : DataReference<Double>() {
    override fun resolve(pathResolver: (String) -> Double?): Double = value
}

/**
 * A number value bound to a data model path.
 */
data class PathNumber(val path: String) : DataReference<Double>() {
    override fun resolve(pathResolver: (String) -> Double?): Double? = pathResolver(path)
}

/**
 * A literal boolean value.
 */
data class LiteralBoolean(val value: Boolean) : DataReference<Boolean>() {
    override fun resolve(pathResolver: (String) -> Boolean?): Boolean = value
}

/**
 * A boolean value bound to a data model path.
 */
data class PathBoolean(val path: String) : DataReference<Boolean>() {
    override fun resolve(pathResolver: (String) -> Boolean?): Boolean? = pathResolver(path)
}

/**
 * A reference to a child component by ID.
 */
data class ComponentReference(val componentId: String)

/**
 * An explicit list of component IDs (for children arrays).
 */
data class ComponentArrayReference(val componentIds: List<String>)

/**
 * A template reference for data-driven lists.
 * The template component is rendered for each item in the data binding path.
 */
data class TemplateReference(
    val componentId: String,
    val dataBinding: String
)

/**
 * Represents children of a container widget - either explicit list or template.
 */
sealed class ChildrenReference {
    data class ExplicitList(val componentIds: List<String>) : ChildrenReference()
    data class Template(val componentId: String, val dataBinding: String) : ChildrenReference()
}

/**
 * Utilities for parsing data references from JSON.
 */
object DataReferenceParser {

    /**
     * Parses a string reference from a JSON element.
     * Supports: literalString, path, or plain string primitive.
     */
    fun parseString(element: JsonElement?): DataReference<String>? {
        if (element == null) return null

        return when (element) {
            is JsonPrimitive -> LiteralString(element.contentOrNull ?: "")
            is JsonObject -> {
                element["literalString"]?.jsonPrimitive?.contentOrNull?.let { LiteralString(it) }
                    ?: element["path"]?.jsonPrimitive?.contentOrNull?.let { PathString(it) }
            }
            else -> null
        }
    }

    /**
     * Parses a number reference from a JSON element.
     * Supports: literalNumber, path, or plain number primitive.
     */
    fun parseNumber(element: JsonElement?): DataReference<Double>? {
        if (element == null) return null

        return when (element) {
            is JsonPrimitive -> element.doubleOrNull?.let { LiteralNumber(it) }
            is JsonObject -> {
                element["literalNumber"]?.jsonPrimitive?.doubleOrNull?.let { LiteralNumber(it) }
                    ?: element["path"]?.jsonPrimitive?.contentOrNull?.let { PathNumber(it) }
            }
            else -> null
        }
    }

    /**
     * Parses a boolean reference from a JSON element.
     * Supports: literalBoolean, path, or plain boolean primitive.
     */
    fun parseBoolean(element: JsonElement?): DataReference<Boolean>? {
        if (element == null) return null

        return when (element) {
            is JsonPrimitive -> element.booleanOrNull?.let { LiteralBoolean(it) }
            is JsonObject -> {
                element["literalBoolean"]?.jsonPrimitive?.booleanOrNull?.let { LiteralBoolean(it) }
                    ?: element["path"]?.jsonPrimitive?.contentOrNull?.let { PathBoolean(it) }
            }
            else -> null
        }
    }

    /**
     * Parses a component reference (child ID) from a JSON element.
     */
    fun parseComponentRef(element: JsonElement?): ComponentReference? {
        if (element == null) return null

        return when (element) {
            is JsonPrimitive -> element.contentOrNull?.let { ComponentReference(it) }
            else -> null
        }
    }

    /**
     * Parses a component array reference from a JSON element.
     * Supports: explicitList array or path binding.
     */
    fun parseComponentArray(element: JsonElement?): ComponentArrayReference? {
        if (element == null) return null

        return when (element) {
            is JsonObject -> {
                element["explicitList"]?.jsonArray?.mapNotNull {
                    it.jsonPrimitive.contentOrNull
                }?.let { ComponentArrayReference(it) }
            }
            else -> null
        }
    }

    /**
     * Parses a children reference from a JSON element.
     * Supports both explicit list and template-based children.
     *
     * Explicit list format:
     * ```json
     * {"explicitList": ["child1", "child2"]}
     * ```
     *
     * Template format:
     * ```json
     * {"template": {"componentId": "item-template", "dataBinding": "/items"}}
     * ```
     */
    fun parseChildren(element: JsonElement?): ChildrenReference? {
        if (element == null) return null

        return when (element) {
            is JsonObject -> {
                // Check for explicit list first
                element["explicitList"]?.jsonArray?.mapNotNull {
                    it.jsonPrimitive.contentOrNull
                }?.let { return ChildrenReference.ExplicitList(it) }

                // Check for template
                element["template"]?.let { templateElement ->
                    if (templateElement is JsonObject) {
                        val componentId = templateElement["componentId"]?.jsonPrimitive?.contentOrNull
                        val dataBinding = templateElement["dataBinding"]?.jsonPrimitive?.contentOrNull
                        if (componentId != null && dataBinding != null) {
                            return ChildrenReference.Template(componentId, dataBinding)
                        }
                    }
                    null
                }
            }
            else -> null
        }
    }
}
