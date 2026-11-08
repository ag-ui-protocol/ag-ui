package com.agui.client.state

/**
 * Thrown when a state delta (RFC 6902 JSON Patch) is invalid or cannot be applied.
 */
class JsonPatchApplicationException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
