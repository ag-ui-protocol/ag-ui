package com.agui.platform

import platform.Foundation.NSProcessInfo

actual object Platform {
    actual val name: String = "macOS ${NSProcessInfo.processInfo.operatingSystemVersionString}"
    actual val availableProcessors: Int = NSProcessInfo.processInfo.processorCount.toInt()
}
