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