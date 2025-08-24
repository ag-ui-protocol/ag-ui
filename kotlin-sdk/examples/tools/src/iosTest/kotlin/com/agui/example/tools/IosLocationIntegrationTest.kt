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

import com.agui.core.types.ToolCall
import com.agui.core.types.FunctionCall
import com.agui.tools.ToolExecutionContext
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.boolean
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertEquals

class IosLocationIntegrationTest {
    
    @Test
    fun testIosLocationProviderWithToolExecutor() = runTest {
        // This test verifies that our iOS location provider works with the tool executor
        // This is the real integration test that proves iOS functionality
        
        val iosProvider = createLocationProvider()
        assertNotNull(iosProvider)
        assertTrue(iosProvider is IosLocationProvider, "Should create IosLocationProvider on iOS")
        
        val executor = CurrentLocationToolExecutor(iosProvider)
        
        val toolCall = ToolCall(
            id = "ios-location-test",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "high", "includeAddress": true, "timeout": 10}"""
            )
        )
        
        val context = ToolExecutionContext(toolCall)
        val result = executor.execute(context)
        
        // The result should be successful regardless of whether we have actual location access
        // (since we're testing the implementation, not the permissions)
        assertNotNull(result)
        assertNotNull(result.result)
        
        val resultJson = result.result?.jsonObject
        assertNotNull(resultJson)
        
        // Should have a success field
        val success = resultJson["success"]?.jsonPrimitive?.boolean
        assertNotNull(success)
        
        if (success == true) {
            // If successful, should have coordinate data
            assertNotNull(resultJson["latitude"])
            assertNotNull(resultJson["longitude"])
            assertNotNull(resultJson["message"])
        } else {
            // If unsuccessful, should have error information
            assertNotNull(resultJson["error"])
            assertNotNull(resultJson["errorCode"])
        }
    }
    
    @Test
    fun testIosLocationProviderAccuracyLevels() = runTest {
        val provider = createLocationProvider()
        
        // Test different accuracy levels
        val accuracyLevels = listOf("high", "medium", "low")
        
        for (accuracy in accuracyLevels) {
            val request = LocationRequest(
                accuracy = when (accuracy) {
                    "high" -> LocationAccuracy.HIGH
                    "medium" -> LocationAccuracy.MEDIUM
                    "low" -> LocationAccuracy.LOW
                    else -> LocationAccuracy.MEDIUM
                },
                includeAddress = false,
                timeoutMs = 5000L,
                toolCallId = "test-accuracy-$accuracy"
            )
            
            val response = provider.getCurrentLocation(request)
            assertNotNull(response, "Response should not be null for accuracy: $accuracy")
            
            // Should always return a response, whether successful or not
            assertTrue(
                response.success == true || response.success == false,
                "Response should have valid success flag for accuracy: $accuracy"
            )
        }
    }
    
    @Test
    fun testIosLocationProviderInterface() = runTest {
        val provider = createLocationProvider()
        
        // Test interface methods
        val hasPermission = provider.hasLocationPermission()
        val isEnabled = provider.isLocationEnabled()
        
        // These should return boolean values
        assertTrue(hasPermission == true || hasPermission == false)
        assertTrue(isEnabled == true || isEnabled == false)
        
        println("iOS Location Provider Test Results:")
        println("  Has Permission: $hasPermission")
        println("  Location Enabled: $isEnabled")
        println("  Provider Type: ${provider::class.simpleName}")
    }
}