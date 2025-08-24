package com.agui.platform

import platform.Foundation.NSProcessInfo
import platform.UIKit.UIDevice

/**
 * iOS-specific platform implementations for ag-ui-4k core.
 */
actual object Platform {
    /**
     * Returns the platform name and version.
     */
    actual val name: String = UIDevice.currentDevice.let {
        "${it.systemName()} ${it.systemVersion()}"
    }

    /**
     * Gets the number of available processors for concurrent operations.
     */
    actual val availableProcessors: Int = NSProcessInfo.processInfo.processorCount.toInt()
}
