package com.agui.client.state

import kotlinx.serialization.json.*

/**
 * JSON Pointer utilities implementing RFC 6901 specification.
 * 
 * JSON Pointer is a string syntax for identifying a specific value within a JSON document.
 * It provides a standardized way to navigate nested JSON structures using path-like syntax.
 * 
 * Features:
 * - RFC 6901 compliant implementation
 * - Proper handling of escape sequences (~0 for ~, ~1 for /)
 * - Support for array indices and object properties
 * - Path creation and segment encoding utilities
 * - Null-safe navigation with graceful failure handling
 * 
 * Path Format:
 * - Empty string "" or "/" refers to the root document
 * - "/foo" refers to the "foo" property of the root object
 * - "/foo/bar" refers to the "bar" property of the "foo" object
 * - "/foo/0" refers to the first element of the "foo" array
 * - "/foo/bar~1baz" refers to the "bar/baz" property (/ is escaped as ~1)
 * - "/foo/bar~0baz" refers to the "bar~baz" property (~ is escaped as ~0)
 * 
 * @see <a href="https://tools.ietf.org/html/rfc6901">RFC 6901 - JSON Pointer</a>
 */
object JsonPointer {

    /**
     * Evaluates a JSON Pointer path against a JSON element.
     *
     * @param element The JSON element to evaluate against
     * @param path The JSON Pointer path (e.g., "/foo/bar/0")
     * @return The element at the path, or null if not found
     */
    fun evaluate(element: JsonElement, path: String): JsonElement? {
        if (path.isEmpty() || path == "/") return element

        // Split path and decode segments
        val segments = path.trimStart('/').split('/')
            .map { decodeSegment(it) }

        // Navigate through the JSON structure
        return segments.fold(element as JsonElement?) { current, segment ->
            when (current) {
                is JsonObject -> current[segment]
                is JsonArray -> {
                    val index = segment.toIntOrNull()
                    if (index != null && index in 0 until current.size) {
                        current[index]
                    } else {
                        null
                    }
                }
                else -> null
            }
        }
    }

    /**
     * Decodes a JSON Pointer segment.
     * Handles escape sequences: ~0 -> ~ and ~1 -> /
     */
    private fun decodeSegment(segment: String): String {
        return segment
            .replace("~1", "/")
            .replace("~0", "~")
    }

    /**
     * Encodes a string for use as a JSON Pointer segment.
     * 
     * This function applies the required escape sequences for JSON Pointer:
     * - '~' becomes '~0'
     * - '/' becomes '~1'
     * 
     * These escapes are necessary because both characters have special meaning
     * in JSON Pointer syntax.
     * 
     * @param segment The string to encode
     * @return The encoded string safe for use in JSON Pointer paths
     * 
     * @see decodeSegment
     */
    fun encodeSegment(segment: String): String {
        return segment
            .replace("~", "~0")
            .replace("/", "~1")
    }

    /**
     * Creates a JSON Pointer path from multiple segments.
     * 
     * This is a convenience function that properly encodes each segment
     * and joins them with '/' separators to create a valid JSON Pointer path.
     * 
     * @param segments The path segments to combine (will be encoded automatically)
     * @return A properly formatted JSON Pointer path
     * 
     * Example:
     * ```kotlin
     * createPath("users", "0", "name") // Returns "/users/0/name"
     * createPath("foo/bar", "baz~test") // Returns "/foo~1bar/baz~0test"
     * ```
     * 
     * @see encodeSegment
     */
    fun createPath(vararg segments: String): String {
        return "/" + segments.joinToString("/") { encodeSegment(it) }
    }
}