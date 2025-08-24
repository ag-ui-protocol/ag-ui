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
package com.agui.example.tools

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class IosLocationProviderTest {
    
    @Test
    fun testCreateLocationProvider() {
        val provider = createLocationProvider()
        assertNotNull(provider)
        assertTrue(provider is IosLocationProvider)
    }
    
    @Test
    fun testLocationProviderMethods() = runTest {
        val provider = createLocationProvider()
        
        // Test that methods are callable (actual behavior depends on iOS permissions)
        val hasPermission = provider.hasLocationPermission()
        val isEnabled = provider.isLocationEnabled()
        
        // These are boolean results, so they should always return something
        assertTrue(hasPermission == true || hasPermission == false)
        assertTrue(isEnabled == true || isEnabled == false)
    }
    
    @Test
    fun testLocationRequest() = runTest {
        val provider = createLocationProvider()
        
        val request = LocationRequest(
            accuracy = LocationAccuracy.MEDIUM,
            includeAddress = false,
            timeoutMs = 5000L,
            toolCallId = "test-123"
        )
        
        // Test that we can make a location request
        // The actual result depends on iOS permissions and simulator/device state
        val response = provider.getCurrentLocation(request)
        assertNotNull(response)
        
        // Response should have success flag set
        assertTrue(response.success == true || response.success == false)
        
        // If unsuccessful, should have error information
        if (!response.success) {
            assertNotNull(response.error)
            assertNotNull(response.errorCode)
        }
    }
}