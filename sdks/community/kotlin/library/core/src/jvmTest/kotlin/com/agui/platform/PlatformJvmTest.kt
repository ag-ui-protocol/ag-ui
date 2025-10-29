package com.agui.platform

import kotlin.test.Test
import kotlin.test.assertTrue

class PlatformJvmTest {

    @Test
    fun platformProvidesJvmDetails() {
        assertTrue(Platform.name.startsWith("JVM"), "Expected JVM platform name, got ${Platform.name}")
        assertTrue(Platform.availableProcessors > 0, "Available processors should be positive")
    }
}
