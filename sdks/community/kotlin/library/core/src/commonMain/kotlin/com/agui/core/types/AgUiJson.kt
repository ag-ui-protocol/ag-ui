package com.agui.core.types

import kotlinx.serialization.json.Json

/**
 * Configured JSON instance for AG-UI protocol serialization.
 *
 * Configuration:
 * - Uses "type" as the class discriminator for polymorphic types
 * - Ignores unknown keys for forward compatibility
 * - Lenient parsing for flexibility
 * - Encodes defaults to ensure protocol compliance
 * - Does NOT include nulls by default (explicitNulls = false)
 */
val AgUiJson by lazy {
    Json {
        serializersModule = AgUiSerializersModule
        ignoreUnknownKeys = true     // Forward compatibility
        isLenient = true             // Allow flexibility in parsing
        encodeDefaults = true        // Ensure all fields are present
        explicitNulls = false        // Don't include null fields
        prettyPrint = false          // Compact output for efficiency
    }
}

/**
 * Pretty-printing JSON instance for debugging.
 */
val AgUiJsonPretty = Json(from = AgUiJson) {
    prettyPrint = true
}