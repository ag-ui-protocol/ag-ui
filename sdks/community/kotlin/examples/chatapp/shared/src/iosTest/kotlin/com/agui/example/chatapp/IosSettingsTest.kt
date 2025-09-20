package com.agui.example.chatapp

import com.agui.example.chatapp.util.getPlatformSettings
import com.russhwolf.settings.Settings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class IosSettingsTest {
    
    @Test
    fun testIosSettingsCreation() {
        val settings = getPlatformSettings()
        assertNotNull(settings)
        assertTrue(settings is Settings)
    }
    
    @Test
    fun testIosSettingsPersistence() {
        val settings = getPlatformSettings()
        val testKey = "ios_test_key_${kotlinx.datetime.Clock.System.now().toEpochMilliseconds()}"
        val testValue = "ios_test_value"
        
        // Write value
        settings.putString(testKey, testValue)
        
        // Read value
        val retrievedValue = settings.getStringOrNull(testKey)
        assertEquals(testValue, retrievedValue)
        
        // Clean up
        settings.remove(testKey)
        
        // Verify cleanup
        val afterRemoval = settings.getStringOrNull(testKey)
        assertEquals(null, afterRemoval)
    }
    
    @Test
    fun testIosSettingsWithAgentRepository() {
        // This test verifies that the AgentRepository works correctly on iOS
        val settings = getPlatformSettings()
        val repository = com.agui.example.chatapp.data.repository.AgentRepository.getInstance(settings)
        
        assertNotNull(repository)
        assertNotNull(repository.agents)
        assertNotNull(repository.activeAgent)
        assertNotNull(repository.currentSession)
    }
}