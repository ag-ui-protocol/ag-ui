package com.agui.core.types

import kotlinx.serialization.json.Json

/**
 * Configured JSON instance for AG-UI protocol serialization.
 *
 * Configuration:
 * - Uses "type" as the class discriminator for polymorphic types
 * - Ignores unknown keys for forward compatibility
 * - Lenient parsing for pre-1.0 compatibility
 * - Encodes defaults to ensure protocol compliance
 * - Does NOT include nulls by default (explicitNulls = false)
 */
val AgUiJson by lazy {
    Json {
        serializersModule = AgUiSerializersModule
        ignoreUnknownKeys = true     // Forward compatibility
        isLenient = true             // Preserve the pre-1.0 compatibility reader
        encodeDefaults = true        // Ensure all fields are present
        explicitNulls = false        // Don't include null fields
        prettyPrint = false          // Compact output for efficiency
    }
}

/**
 * Strict AG-UI 1.0 binding for schema validation and protocol writers.
 *
 * Consumers use [AgUiJson] at the compatibility boundary. They then pass known
 * events through the client verifier before application delivery.
 */
val AgUiStrictJson by lazy {
    Json(from = AgUiJson) {
        ignoreUnknownKeys = false
        isLenient = false
    }
}

/**
 * Pretty-printing JSON instance for debugging.
 */
val AgUiJsonPretty = Json(from = AgUiJson) {
    prettyPrint = true
}
