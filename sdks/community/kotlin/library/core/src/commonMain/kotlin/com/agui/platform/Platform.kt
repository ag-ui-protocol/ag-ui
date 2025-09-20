package com.agui.platform

/**
 * Platform-specific implementations for ag-ui-4k core functionality.
 * Each platform must provide actual implementations of these interfaces.
 */
expect object Platform {
    /**
     * Returns the platform name and version.
     */
    val name: String

    /**
     * Gets the number of available processors for concurrent operations.
     */
    val availableProcessors: Int
}

/**
 * Gets the current platform information.
 */
fun currentPlatform(): String = Platform.name