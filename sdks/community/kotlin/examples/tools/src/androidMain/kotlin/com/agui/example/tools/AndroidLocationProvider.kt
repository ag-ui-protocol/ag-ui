package com.agui.example.tools

/**
 * Create Android-specific location provider.
 * 
 * Note: For a real Android app, you would use createAndroidLocationProvider
 * and pass your application context.
 */
actual fun createLocationProvider(): LocationProvider {
    // Returns stub implementation since we don't have access to Android context here
    return StubLocationProvider()
}

/**
 * Create Android location provider with proper context.
 * Use this function in Android applications.
 * 
 * Example:
 * ```
 * val locationProvider = createAndroidLocationProvider(applicationContext)
 * val locationTool = CurrentLocationToolExecutor(locationProvider)
 * ```
 */
fun createAndroidLocationProvider(context: android.content.Context): LocationProvider {
    return AndroidLocationProvider(context)
}

/**
 * Simple Android location provider that returns mock data.
 * 
 * In a real implementation, you would:
 * 1. Check for location permissions
 * 2. Use LocationManager or FusedLocationProviderClient
 * 3. Return actual GPS coordinates
 * 
 * This stub implementation allows the library to compile without
 * requiring Google Play Services or complex Android dependencies.
 */
class AndroidLocationProvider(
    private val context: android.content.Context
) : LocationProvider {
    
    override suspend fun getCurrentLocation(request: LocationRequest): LocationResponse {
        // For now, just return mock data
        // Real implementation would use LocationManager or Google Play Services
        return LocationResponse(
            success = true,
            latitude = 37.4220936,
            longitude = -122.083922,
            accuracyMeters = 15.0,
            timestamp = System.currentTimeMillis(),
            address = if (request.includeAddress) "Mountain View, CA" else null,
            message = "Mock Android location"
        )
    }
    
    override suspend fun hasLocationPermission(): Boolean {
        // Real implementation would check:
        // ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
        return true
    }
    
    override suspend fun isLocationEnabled(): Boolean {
        // Real implementation would check LocationManager
        return true
    }
}