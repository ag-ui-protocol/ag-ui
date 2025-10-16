package com.agui.platform

import android.os.Build

/**
 * Android-specific platform implementations for ag-ui-4k core.
 */
actual object Platform {
    /**
     * Returns the platform name and version.
     */
    actual val name: String = "Android ${Build.VERSION.SDK_INT}"

    /**
     * Gets the number of available processors for concurrent operations.
     */
    actual val availableProcessors: Int = Runtime.getRuntime().availableProcessors()
}
