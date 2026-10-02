package com.agui.client.state

/**
 * Thrown when a state delta (RFC 6902 JSON Patch) cannot be applied.
 */
class JsonPatchApplicationException(message: String) : RuntimeException(message)
