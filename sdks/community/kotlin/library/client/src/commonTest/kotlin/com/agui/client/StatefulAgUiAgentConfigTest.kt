package com.agui.client

import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class StatefulAgUiAgentConfigTest {

    @Test
    fun testDefaultStatefulConfiguration() {
        val config = StatefulAgUiAgentConfig()
        
        assertTrue(config.initialState is JsonObject)
        assertTrue((config.initialState as JsonObject).isEmpty())
        assertEquals(100, config.maxHistoryLength)
    }

    @Test
    fun testStatefulConfigurationInheritance() {
        val config = StatefulAgUiAgentConfig().apply {
            bearerToken = "stateful-token"
            maxHistoryLength = 50
        }
        
        val headers = config.buildHeaders()
        assertEquals("Bearer stateful-token", headers["Authorization"])
        assertEquals(50, config.maxHistoryLength)
    }
}