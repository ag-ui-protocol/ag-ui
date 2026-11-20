package com.agui.client.state

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Returns this document with a top level whose == compares iteratively
 * instead of recursing. StateFlow checks == when a new state is published
 * and, per collector, when replaying the current state; JsonObject and
 * JsonArray equality recurses, so either check overflows the stack on
 * deeply nested states (see #3318). Wrapping only the top level is enough:
 * the wrapped collections compare their entries with the iterative
 * [jsonElementsEqual], so no level of the comparison recurses, while reads,
 * iteration and serialization are unchanged. Primitives and JsonNull are
 * returned as-is (their == never recurses). The wrapper delegates to the
 * document itself (a JsonObject is a Map, a JsonArray is a List), so the
 * wrapped document keeps exactly the same entries.
 */
internal fun JsonElement.withIterativeEquality(): JsonElement = when (this) {
    is JsonObject -> JsonObject(IterativeEqualityMap(this))
    is JsonArray -> JsonArray(IterativeEqualityList(this))
    else -> this
}

/**
 * A Map view whose == compares entries with the iterative
 * [jsonElementsEqual] instead of recursing through JsonObject/JsonArray
 * equals. Every other behaviour delegates to the wrapped map.
 */
private class IterativeEqualityMap(
    private val delegate: Map<String, JsonElement>
) : Map<String, JsonElement> by delegate {
    override fun equals(other: Any?): Boolean {
        if (other === this) return true
        if (other !is Map<*, *>) return false
        if (other.size != delegate.size) return false
        for ((key, value) in delegate) {
            if (!other.containsKey(key)) return false
            val otherValue = other[key] as? JsonElement ?: return false
            if (!jsonElementsEqual(value, otherValue)) return false
        }
        return true
    }

    override fun hashCode(): Int = delegate.hashCode()
    override fun toString(): String = delegate.toString()
}

/**
 * A List view whose == compares elements with the iterative
 * [jsonElementsEqual] instead of recursing through JsonObject/JsonArray
 * equals. Every other behaviour delegates to the wrapped list.
 */
private class IterativeEqualityList(
    private val delegate: List<JsonElement>
) : List<JsonElement> by delegate {
    override fun equals(other: Any?): Boolean {
        if (other === this) return true
        if (other !is List<*>) return false
        if (other.size != delegate.size) return false
        for (index in delegate.indices) {
            val otherValue = other[index] as? JsonElement ?: return false
            if (!jsonElementsEqual(delegate[index], otherValue)) return false
        }
        return true
    }

    override fun hashCode(): Int = delegate.hashCode()
    override fun toString(): String = delegate.toString()
}
