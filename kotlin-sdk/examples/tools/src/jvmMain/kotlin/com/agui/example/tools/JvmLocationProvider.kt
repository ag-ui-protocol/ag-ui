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