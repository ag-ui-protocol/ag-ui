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