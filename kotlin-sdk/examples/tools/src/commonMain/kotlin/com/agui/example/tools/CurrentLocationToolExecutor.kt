package com.agui.example.tools

import com.agui.core.types.Tool
import com.agui.core.types.ToolCall
import com.agui.tools.AbstractToolExecutor
import com.agui.tools.ToolExecutionContext
import com.agui.tools.ToolExecutionResult
import com.agui.tools.ToolValidationResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Built-in tool executor for getting the current location.
 * 
 * This tool allows agents to get the user's current location through a platform-specific
 * location provider with proper permission handling.
 */
class CurrentLocationToolExecutor(
    private val locationProvider: LocationProvider
) : AbstractToolExecutor(
    tool = Tool(
        name = "current_location",
        description = "Get the user's current location (latitude, longitude, and optional address)",
        parameters = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                putJsonObject("accuracy") {
                    put("type", "string")
                    put("enum", buildJsonArray {
                        add("high")
                        add("medium")
                        add("low")
                    })
                    put("description", "Requested location accuracy level")
                    put("default", "medium")
                }
                putJsonObject("includeAddress") {
                    put("type", "boolean")
                    put("description", "Whether to include reverse geocoded address")
                    put("default", false)
                }
                putJsonObject("timeout") {
                    put("type", "integer")
                    put("description", "Timeout in seconds for location request")
                    put("default", 30)
                    put("minimum", 5)
                    put("maximum", 120)
                }
            }
        }
    )
) {
    
    override suspend fun executeInternal(context: ToolExecutionContext): ToolExecutionResult {
        // Parse the tool call arguments
        val args = try {
            Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
        } catch (e: Exception) {
            return ToolExecutionResult.failure("Invalid JSON arguments: ${e.message}")
        }
        
        // Extract parameters with defaults
        val accuracyStr = args["accuracy"]?.jsonPrimitive?.content ?: "medium"
        val includeAddress = args["includeAddress"]?.jsonPrimitive?.boolean ?: false
        val timeoutSeconds = args["timeout"]?.jsonPrimitive?.int ?: 30
        
        // Parse accuracy level
        val accuracy = try {
            LocationAccuracy.valueOf(accuracyStr.uppercase())
        } catch (e: Exception) {
            return ToolExecutionResult.failure("Invalid accuracy: $accuracyStr. Must be high, medium, or low")
        }
        
        // Validate timeout
        if (timeoutSeconds < 5 || timeoutSeconds > 120) {
            return ToolExecutionResult.failure("Timeout must be between 5 and 120 seconds")
        }
        
        // Create location request
        val request = LocationRequest(
            accuracy = accuracy,
            includeAddress = includeAddress,
            timeoutMs = timeoutSeconds * 1000L,
            toolCallId = context.toolCall.id,
            threadId = context.threadId,
            runId = context.runId
        )
        
        // Get location through provider
        return try {
            val response = locationProvider.getCurrentLocation(request)
            
            if (response.success) {
                val resultJson = buildJsonObject {
                    put("success", true)
                    put("latitude", response.latitude!!)
                    put("longitude", response.longitude!!)
                    put("accuracy", response.accuracyMeters ?: 0.0)
                    put("timestamp", response.timestamp ?: kotlinx.datetime.Clock.System.now().toEpochMilliseconds())
                    
                    if (response.address != null) {
                        put("address", response.address)
                    }
                    
                    if (response.altitude != null) {
                        put("altitude", response.altitude)
                    }
                    
                    if (response.bearing != null) {
                        put("bearing", response.bearing)
                    }
                    
                    if (response.speed != null) {
                        put("speed", response.speed)
                    }
                }
                
                ToolExecutionResult.success(
                    result = resultJson,
                    message = response.message ?: "Location retrieved successfully"
                )
            } else {
                val resultJson = buildJsonObject {
                    put("success", false)
                    put("error", response.error ?: "Unknown error")
                    put("errorCode", response.errorCode ?: "UNKNOWN")
                }
                
                ToolExecutionResult.failure(
                    message = response.error ?: "Failed to get location",
                    result = resultJson
                )
            }
        } catch (e: Exception) {
            ToolExecutionResult.failure("Location request failed: ${e.message}")
        }
    }
    
    override fun validate(toolCall: ToolCall): ToolValidationResult {
        val args = try {
            Json.parseToJsonElement(toolCall.function.arguments).jsonObject
        } catch (e: Exception) {
            return ToolValidationResult.failure("Invalid JSON arguments: ${e.message}")
        }
        
        val errors = mutableListOf<String>()
        
        // Validate accuracy if provided
        args["accuracy"]?.jsonPrimitive?.content?.let { accuracyStr ->
            try {
                LocationAccuracy.valueOf(accuracyStr.uppercase())
            } catch (e: Exception) {
                errors.add("Invalid accuracy: $accuracyStr. Must be high, medium, or low")
            }
        }
        
        // Validate timeout if provided
        args["timeout"]?.jsonPrimitive?.int?.let { timeout ->
            if (timeout < 5 || timeout > 120) {
                errors.add("Timeout must be between 5 and 120 seconds")
            }
        }
        
        return if (errors.isEmpty()) {
            ToolValidationResult.success()
        } else {
            ToolValidationResult.failure(errors)
        }
    }
    
    override fun getMaxExecutionTimeMs(): Long? {
        // Location requests can take time, especially for high accuracy
        return 120_000L // 2 minutes max
    }
}

/**
 * Location accuracy levels.
 */
enum class LocationAccuracy {
    HIGH,    // GPS, highest accuracy, more battery usage
    MEDIUM,  // Network + GPS, balanced accuracy and battery
    LOW      // Network only, lower accuracy, less battery usage
}

/**
 * Request for location information.
 */
data class LocationRequest(
    val accuracy: LocationAccuracy = LocationAccuracy.MEDIUM,
    val includeAddress: Boolean = false,
    val timeoutMs: Long = 30_000L,
    val toolCallId: String,
    val threadId: String? = null,
    val runId: String? = null
)

/**
 * Response from location request.
 */
data class LocationResponse(
    val success: Boolean,
    val latitude: Double? = null,
    val longitude: Double? = null,
    val accuracyMeters: Double? = null,
    val altitude: Double? = null,
    val bearing: Float? = null,
    val speed: Float? = null,
    val timestamp: Long? = null,
    val address: String? = null,
    val error: String? = null,
    val errorCode: String? = null,
    val message: String? = null
)

/**
 * Interface for providing location information.
 * 
 * Platform-specific implementations should handle permissions, GPS access,
 * and privacy considerations appropriately.
 */
interface LocationProvider {
    /**
     * Get the current location.
     * 
     * @param request The location request with accuracy and options
     * @return The location response
     * @throws Exception if the operation fails
     */
    suspend fun getCurrentLocation(request: LocationRequest): LocationResponse
    
    /**
     * Check if location permissions are granted.
     * 
     * @return true if location access is available
     */
    suspend fun hasLocationPermission(): Boolean
    
    /**
     * Check if location services are enabled on the device.
     * 
     * @return true if location services are enabled
     */
    suspend fun isLocationEnabled(): Boolean
}

/**
 * Stub location provider for JVM that returns mock location data.
 * This is used when running on platforms without location services.
 */
class StubLocationProvider : LocationProvider {
    
    override suspend fun getCurrentLocation(request: LocationRequest): LocationResponse {
        // Return a mock location (Googleplex in Mountain View, CA)
        return LocationResponse(
            success = true,
            latitude = 37.4220936,
            longitude = -122.083922,
            accuracyMeters = 10.0,
            altitude = 30.0,
            timestamp = kotlinx.datetime.Clock.System.now().toEpochMilliseconds(),
            address = if (request.includeAddress) "1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA" else null,
            message = "Mock location provided (JVM stub implementation)"
        )
    }
    
    override suspend fun hasLocationPermission(): Boolean = true
    
    override suspend fun isLocationEnabled(): Boolean = true
}

/**
 * Platform-specific function to create the appropriate location provider.
 * This will be implemented in platform-specific source sets.
 */
expect fun createLocationProvider(): LocationProvider