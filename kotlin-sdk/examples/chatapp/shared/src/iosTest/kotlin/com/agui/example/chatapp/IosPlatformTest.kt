package com.agui.example.chatapp

import com.agui.example.chatapp.util.getPlatformName
import com.agui.example.chatapp.util.getPlatformSettings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class IosPlatformTest {
    
    @Test
    fun testPlatformName() {
        assertEquals("iOS", getPlatformName())
    }
    
    @Test
    fun testPlatformSettings() {
        val settings = getPlatformSettings()
        assertNotNull(settings)
        
        // Test that we can write and read a value
        val testKey = "test_key"
        val testValue = "test_value"
        
        settings.putString(testKey, testValue)
        assertEquals(testValue, settings.getString(testKey, ""))
        
        // Clean up
        settings.remove(testKey)
    }
}