/*
 * MIT License
 *
 * Copyright (c) 2025 Mark Fogle
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
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