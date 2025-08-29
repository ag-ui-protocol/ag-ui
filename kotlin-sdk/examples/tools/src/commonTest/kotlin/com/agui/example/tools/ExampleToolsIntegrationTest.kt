package com.agui.example.tools

import com.agui.core.types.FunctionCall
import com.agui.core.types.Tool
import com.agui.core.types.ToolCall
import com.agui.client.AgUiAgent
import com.agui.tools.ToolExecutionContext
import com.agui.tools.ToolExecutionResult
import com.agui.tools.ToolExecutor
import com.agui.tools.toolRegistry
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ExampleToolsIntegrationTest {

    // Mock location provider for testing
    class MockLocationProvider : LocationProvider {
        var shouldSucceed = true
        var mockLatitude = 37.7749
        var mockLongitude = -122.4194
        var mockAddress = "San Francisco, CA"
        override suspend fun getCurrentLocation(request: LocationRequest): LocationResponse {
            if (!shouldSucceed) {
                return LocationResponse(
                    success = false,
                    error = "Location services unavailable",
                    errorCode = "LOCATION_DISABLED"
                )
            }

            return LocationResponse(
                success = true,
                latitude = mockLatitude,
                longitude = mockLongitude,
                accuracyMeters = 10.0,
                timestamp = kotlinx.datetime.Clock.System.now().toEpochMilliseconds(),
                address = if (request.includeAddress) mockAddress else null,
                message = "Location retrieved successfully"
            )
        }

        override suspend fun hasLocationPermission(): Boolean = shouldSucceed

        override suspend fun isLocationEnabled(): Boolean = shouldSucceed
    }

    @Test
    fun testCurrentLocationToolExecution() = runTest {
        val mockProvider = MockLocationProvider()
        val locationTool = CurrentLocationToolExecutor(mockProvider)

        // Test successful location request
        val toolCall = ToolCall(
            id = "loc_1",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "high", "includeAddress": true, "timeout": 30}"""
            )
        )

        val context = ToolExecutionContext(
            toolCall = toolCall,
            threadId = "test_thread",
            runId = "test_run"
        )

        val result = locationTool.execute(context)

        assertTrue(result.success)
        assertNotNull(result.result)
        
        val locationData = result.result!!.jsonObject
        assertEquals(true, locationData["success"]?.jsonPrimitive?.boolean)
        assertEquals(37.7749, locationData["latitude"]?.jsonPrimitive?.double)
        assertEquals(-122.4194, locationData["longitude"]?.jsonPrimitive?.double)
        assertEquals("San Francisco, CA", locationData["address"]?.jsonPrimitive?.content)
    }

    @Test
    fun testCurrentLocationToolFailure() = runTest {
        val mockProvider = MockLocationProvider().apply {
            shouldSucceed = false
        }
        val locationTool = CurrentLocationToolExecutor(mockProvider)

        val toolCall = ToolCall(
            id = "loc_fail",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "medium"}"""
            )
        )

        val context = ToolExecutionContext(toolCall = toolCall)
        val result = locationTool.execute(context)

        assertFalse(result.success)
        assertTrue(result.message?.contains("Location services unavailable") == true)
        
        val errorData = result.result?.jsonObject
        assertEquals(false, errorData?.get("success")?.jsonPrimitive?.boolean)
        assertEquals("LOCATION_DISABLED", errorData?.get("errorCode")?.jsonPrimitive?.content)
    }

    @Test
    fun testCurrentLocationToolValidation() = runTest {
        val mockProvider = MockLocationProvider()
        val locationTool = CurrentLocationToolExecutor(mockProvider)

        // Test valid parameters
        val validCall = ToolCall(
            id = "valid_loc",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "low", "includeAddress": false, "timeout": 60}"""
            )
        )

        val validResult = locationTool.validate(validCall)
        assertTrue(validResult.isValid)
        assertTrue(validResult.errors.isEmpty())

        // Test invalid accuracy
        val invalidAccuracyCall = ToolCall(
            id = "invalid_acc",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "invalid", "timeout": 30}"""
            )
        )

        val invalidResult = locationTool.validate(invalidAccuracyCall)
        assertFalse(invalidResult.isValid)
        assertTrue(invalidResult.errors.any { it.contains("Invalid accuracy") })

        // Test invalid timeout
        val invalidTimeoutCall = ToolCall(
            id = "invalid_timeout",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"timeout": 300}"""
            )
        )

        val timeoutResult = locationTool.validate(invalidTimeoutCall)
        assertFalse(timeoutResult.isValid)
        assertTrue(timeoutResult.errors.any { it.contains("Timeout must be between") })
    }

    @Test
    fun testAgentWithLocationTool() = runTest {
        val mockProvider = MockLocationProvider().apply {
            mockLatitude = 40.7128
            mockLongitude = -74.0060
            mockAddress = "New York, NY"
        }

        val locationTool = CurrentLocationToolExecutor(mockProvider)
        val toolRegistry = toolRegistry {
            addTool(locationTool)
        }

        val agent = AgUiAgent("https://test-api.com") {
            this.toolRegistry = toolRegistry
            this.systemPrompt = "You are a location-aware assistant."
            this.bearerToken = "test-token"
        }

        // Verify the tool is registered
        val tools = toolRegistry.getAllTools()
        assertEquals(1, tools.size)
        assertEquals("current_location", tools.first().name)

        // Test tool execution through registry
        val toolCall = ToolCall(
            id = "agent_loc",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"includeAddress": true}"""
            )
        )

        val context = ToolExecutionContext(toolCall = toolCall)
        val result = toolRegistry.executeTool(context)

        assertTrue(result.success)
        val locationData = result.result!!.jsonObject
        assertEquals(40.7128, locationData["latitude"]?.jsonPrimitive?.double)
        assertEquals(-74.0060, locationData["longitude"]?.jsonPrimitive?.double)
        assertEquals("New York, NY", locationData["address"]?.jsonPrimitive?.content)
    }

    @Test
    fun testStubLocationProvider() = runTest {
        val stubProvider = StubLocationProvider()

        // Test that it always succeeds
        assertTrue(stubProvider.hasLocationPermission())
        assertTrue(stubProvider.isLocationEnabled())

        val request = LocationRequest(
            accuracy = LocationAccuracy.HIGH,
            includeAddress = true,
            toolCallId = "stub_test"
        )

        val response = stubProvider.getCurrentLocation(request)

        assertTrue(response.success)
        assertEquals(37.4220936, response.latitude)
        assertEquals(-122.083922, response.longitude)
        assertTrue(response.message?.contains("Mock location") == true)
        assertEquals("1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA", response.address)
    }

    @Test
    fun testLocationToolAccuracyLevels() = runTest {
        val mockProvider = MockLocationProvider()
        val locationTool = CurrentLocationToolExecutor(mockProvider)

        // Test all accuracy levels
        val accuracyLevels = listOf("high", "medium", "low")

        for (accuracy in accuracyLevels) {
            val toolCall = ToolCall(
                id = "acc_test_$accuracy",
                function = FunctionCall(
                    name = "current_location",
                    arguments = """{"accuracy": "$accuracy"}"""
                )
            )

            val context = ToolExecutionContext(toolCall = toolCall)
            val result = locationTool.execute(context)

            assertTrue(result.success, "Failed for accuracy: $accuracy")
            assertNotNull(result.result)
        }
    }

    @Test
    fun testLocationToolWithInvalidJson() = runTest {
        val mockProvider = MockLocationProvider()
        val locationTool = CurrentLocationToolExecutor(mockProvider)

        val toolCall = ToolCall(
            id = "invalid_json",
            function = FunctionCall(
                name = "current_location",
                arguments = "invalid json string"
            )
        )

        val context = ToolExecutionContext(toolCall = toolCall)
        val result = locationTool.execute(context)

        assertFalse(result.success)
        assertTrue(result.message?.contains("Invalid JSON") == true)
    }

    @Test
    fun testMultipleExampleTools() = runTest {
        val mockProvider = MockLocationProvider()
        val locationTool = CurrentLocationToolExecutor(mockProvider)

        // Create a mock confirmation tool
        val confirmationTool = object : ToolExecutor {
            override val tool = Tool(
                name = "confirmation",
                description = "Ask user for confirmation",
                parameters = buildJsonObject {
                    put("type", "object")
                    putJsonObject("properties") {
                        putJsonObject("message") {
                            put("type", "string")
                        }
                    }
                    putJsonArray("required") { add("message") }
                }
            )

            override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
                val args = Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
                val message = args["message"]?.jsonPrimitive?.content
                
                return ToolExecutionResult.success(
                    result = buildJsonObject {
                        put("confirmed", true)
                        put("message", message)
                    },
                    message = "User confirmed: $message"
                )
            }
        }

        val toolRegistry = toolRegistry {
            addTool(locationTool)
            addTool(confirmationTool)
        }

        assertEquals(2, toolRegistry.getAllTools().size)
        assertTrue(toolRegistry.isToolRegistered("current_location"))
        assertTrue(toolRegistry.isToolRegistered("confirmation"))

        // Test execution of both tools
        val locationCall = ToolCall(
            id = "multi_loc",
            function = FunctionCall(
                name = "current_location",
                arguments = """{"accuracy": "medium"}"""
            )
        )

        val confirmationCall = ToolCall(
            id = "multi_conf",
            function = FunctionCall(
                name = "confirmation",
                arguments = """{"message": "Share your location?"}"""
            )
        )

        val locationResult = toolRegistry.executeTool(ToolExecutionContext(locationCall))
        val confirmationResult = toolRegistry.executeTool(ToolExecutionContext(confirmationCall))

        assertTrue(locationResult.success)
        assertTrue(confirmationResult.success)

        // Check tool statistics
        val locationStats = toolRegistry.getToolStats("current_location")
        val confirmationStats = toolRegistry.getToolStats("confirmation")

        assertNotNull(locationStats)
        assertNotNull(confirmationStats)
        assertEquals(1, locationStats.executionCount)
        assertEquals(1, confirmationStats.executionCount)
    }
}