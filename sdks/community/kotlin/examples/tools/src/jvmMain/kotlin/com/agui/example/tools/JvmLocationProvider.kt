package com.agui.example.tools

/**
 * Create JVM-specific location provider.
 * Returns a stub implementation since location services aren't available on JVM.
 */
actual fun createLocationProvider(): LocationProvider {
    return JvmLocationProvider()
}

/**
 * JVM-specific location provider that returns mock location data.
 * 
 * This is a stub implementation for desktop/server environments where
 * actual location services are not available or needed.
 */
class JvmLocationProvider : LocationProvider {
    
    private val stubProvider = StubLocationProvider()
    
    override suspend fun getCurrentLocation(request: LocationRequest): LocationResponse {
        return stubProvider.getCurrentLocation(request)
    }
    
    override suspend fun hasLocationPermission(): Boolean {
        return stubProvider.hasLocationPermission()
    }
    
    override suspend fun isLocationEnabled(): Boolean {
        return stubProvider.isLocationEnabled()
    }
}