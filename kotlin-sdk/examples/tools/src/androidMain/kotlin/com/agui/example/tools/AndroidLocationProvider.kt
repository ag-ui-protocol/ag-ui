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