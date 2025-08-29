package com.agui.example.tools

import com.agui.core.types.ToolCall
import com.agui.core.types.FunctionCall
import com.agui.tools.ToolExecutionContext
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class CurrentLocationToolTest {
    
    @Test
    fun testCurrentLocationToolBasic() = runTest {
        val executor = CurrentLocationToolExecutor(StubLocationProvider())
        
        val toolCall = ToolCall(
            id = "test-location-1",
            function = FunctionCall(
                name = "current_location",
                arguments = "{}"
            )
        )
        
        val context = ToolExecutionContext(toolCall)
        val result = executor.execute(context)
        
        assertTrue(result.success)
        assertNotNull(result.result)
        
        val resultJson = result.result?.jsonObject
        assertNotNull(resultJson)
        assertTrue(resultJson["success"]?.jsonPrimitive?.boolean == true)
        assertNotNull(resultJson["latitude"]?.jsonPrimitive?.double)
        assertNotNull(resultJson["longitude"]?.jsonPrimitive?.double)
    }
    
    @Test
    fun testCurrentLocationWithAddress() = runTest {
        val executor = CurrentLocationToolExecutor(StubLocationProvider())
        
        val toolCall = ToolCall(
            id = "test-location-2",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"includeAddress": true}"""
            )
        )
        
        val context = ToolExecutionContext(toolCall)
        val result = executor.execute(context)
        
        assertTrue(result.success)
        val resultJson = result.result?.jsonObject
        assertNotNull(resultJson)
        assertTrue(resultJson["address"] != null)
        assertNotNull(resultJson["address"]?.jsonPrimitive?.content)
    }
    
    @Test
    fun testCurrentLocationAccuracyLevels() = runTest {
        val executor = CurrentLocationToolExecutor(StubLocationProvider())
        
        val accuracyLevels = listOf("high", "medium", "low")
        
        for (accuracy in accuracyLevels) {
            val toolCall = ToolCall(
                id = "test-accuracy-$accuracy",
                function = FunctionCall(
                    name = "current_location",
                    arguments = """{"accuracy": "$accuracy"}"""
                )
            )
            
            val context = ToolExecutionContext(toolCall)
            val result = executor.execute(context)
            
            assertTrue(result.success, "Should succeed for accuracy: $accuracy")
        }
    }
    
    @Test
    fun testCurrentLocationInvalidAccuracy() = runTest {
        val executor = CurrentLocationToolExecutor(StubLocationProvider())
        
        val toolCall = ToolCall(
            id = "test-invalid-accuracy",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "invalid"}"""
            )
        )
        
        val context = ToolExecutionContext(toolCall)
        val result = executor.execute(context)
        
        assertFalse(result.success)
        assertTrue(result.message?.contains("Invalid accuracy") == true)
    }
    
    @Test
    fun testCurrentLocationTimeout() = runTest {
        val executor = CurrentLocationToolExecutor(StubLocationProvider())
        
        val toolCall = ToolCall(
            id = "test-timeout",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"timeout": 15}"""
            )
        )
        
        val context = ToolExecutionContext(toolCall)
        val result = executor.execute(context)
        
        assertTrue(result.success)
    }
    
    @Test
    fun testCurrentLocationInvalidTimeout() = runTest {
        val executor = CurrentLocationToolExecutor(StubLocationProvider())
        
        // Test timeout too short
        val toolCallShort = ToolCall(
            id = "test-timeout-short",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"timeout": 3}"""
            )
        )
        
        val contextShort = ToolExecutionContext(toolCallShort)
        val resultShort = executor.execute(contextShort)
        
        assertFalse(resultShort.success)
        assertTrue(resultShort.message?.contains("Timeout must be between") == true)
        
        // Test timeout too long
        val toolCallLong = ToolCall(
            id = "test-timeout-long",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"timeout": 200}"""
            )
        )
        
        val contextLong = ToolExecutionContext(toolCallLong)
        val resultLong = executor.execute(contextLong)
        
        assertFalse(resultLong.success)
        assertTrue(resultLong.message?.contains("Timeout must be between") == true)
    }
    
    @Test
    fun testCurrentLocationValidation() = runTest {
        val executor = CurrentLocationToolExecutor(StubLocationProvider())
        
        // Test valid call
        val validCall = ToolCall(
            id = "test-validation-valid",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "high", "includeAddress": true, "timeout": 30}"""
            )
        )
        
        val validResult = executor.validate(validCall)
        assertTrue(validResult.isValid)
        
        // Test invalid JSON
        val invalidJsonCall = ToolCall(
            id = "test-validation-invalid-json",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "high", "includeAddress":}"""
            )
        )
        
        val invalidJsonResult = executor.validate(invalidJsonCall)
        assertFalse(invalidJsonResult.isValid)
        
        // Test invalid accuracy
        val invalidAccuracyCall = ToolCall(
            id = "test-validation-invalid-accuracy",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "super_high"}"""
            )
        )
        
        val invalidAccuracyResult = executor.validate(invalidAccuracyCall)
        assertFalse(invalidAccuracyResult.isValid)
    }
    
    @Test
    fun testLocationProviderFailure() = runTest {
        val failingProvider = object : LocationProvider {
            override suspend fun getCurrentLocation(request: LocationRequest): LocationResponse {
                return LocationResponse(
                    success = false,
                    error = "GPS is not available",
                    errorCode = "GPS_UNAVAILABLE"
                )
            }
            
            override suspend fun hasLocationPermission(): Boolean = false
            override suspend fun isLocationEnabled(): Boolean = false
        }
        
        val executor = CurrentLocationToolExecutor(failingProvider)
        
        val toolCall = ToolCall(
            id = "test-failure",
            function = FunctionCall(
                name = "current_location",
                arguments = "{}"
            )
        )
        
        val context = ToolExecutionContext(toolCall)
        val result = executor.execute(context)
        
        assertFalse(result.success)
        assertTrue(result.message?.contains("GPS is not available") == true)
        
        val resultJson = result.result?.jsonObject
        assertNotNull(resultJson)
        assertFalse(resultJson["success"]?.jsonPrimitive?.boolean == true)
        assertEquals("GPS_UNAVAILABLE", resultJson["errorCode"]?.jsonPrimitive?.content)
    }
    
    @Test
    fun testStubLocationProvider() = runTest {
        val provider = StubLocationProvider()
        
        assertTrue(provider.hasLocationPermission())
        assertTrue(provider.isLocationEnabled())
        
        val request = LocationRequest(
            accuracy = LocationAccuracy.HIGH,
            includeAddress = true,
            timeoutMs = 30000L,
            toolCallId = "test-stub"
        )
        
        val response = provider.getCurrentLocation(request)
        
        assertTrue(response.success)
        assertNotNull(response.latitude)
        assertNotNull(response.longitude)
        assertNotNull(response.address)
        assertTrue(response.message?.contains("Mock location") == true)
    }
}