package com.agui.platform

/**
 * JVM-specific platform implementations for ag-ui-4k core.
 */
actual object Platform {
    /**
     * Returns the platform name and version.
     */
    actual val name: String = "JVM ${System.getProperty("java.version")}"

    /**
     * Gets the number of available processors for concurrent operations.
     */
    actual val availableProcessors: Int = Runtime.getRuntime().availableProcessors()
}
