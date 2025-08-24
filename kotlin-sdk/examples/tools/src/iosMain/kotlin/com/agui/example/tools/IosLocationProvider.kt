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

import kotlinx.cinterop.*
import platform.CoreLocation.*
import platform.Foundation.*
import platform.darwin.NSObject
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Create iOS-specific location provider.
 */
actual fun createLocationProvider(): LocationProvider {
    return IosLocationProvider()
}

/**
 * Location delegate that handles CoreLocation callbacks
 */
@OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)
class LocationDelegate : NSObject(), CLLocationManagerDelegateProtocol {
    var locationCallback: ((Result<CLLocation>) -> Unit)? = null
    
    override fun locationManager(manager: CLLocationManager, didUpdateLocations: List<*>) {
        @Suppress("UNCHECKED_CAST")
        val locations = didUpdateLocations as List<CLLocation>
        locations.lastOrNull()?.let { location ->
            locationCallback?.invoke(Result.success(location))
        }
    }
    
    override fun locationManager(manager: CLLocationManager, didFailWithError: NSError) {
        locationCallback?.invoke(Result.failure(Exception(didFailWithError.localizedDescription)))
    }
    
    override fun locationManagerDidChangeAuthorization(manager: CLLocationManager) {
        // Handle authorization changes if needed
        when (CLLocationManager.authorizationStatus()) {
            kCLAuthorizationStatusAuthorizedAlways,
            kCLAuthorizationStatusAuthorizedWhenInUse -> {
                // Permission granted, can request location
            }
            kCLAuthorizationStatusDenied,
            kCLAuthorizationStatusRestricted -> {
                locationCallback?.invoke(Result.failure(Exception("Location permission denied")))
            }
            else -> {
                // Still determining or not requested yet
            }
        }
    }
}

/**
 * iOS location provider using CoreLocation framework.
 */
@OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)
class IosLocationProvider : LocationProvider {
    
    private val locationManager = CLLocationManager()
    private val delegate = LocationDelegate()
    private var locationContinuation: ((Result<CLLocation>) -> Unit)? = null
    
    init {
        locationManager.delegate = delegate
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
    }
    
    override suspend fun getCurrentLocation(request: LocationRequest): LocationResponse {
        // Check permissions first
        if (!hasLocationPermission()) {
            return LocationResponse(
                success = false,
                error = "Location permission not granted",
                errorCode = "PERMISSION_DENIED",
                message = "Please grant location permission in Settings"
            )
        }
        
        if (!isLocationEnabled()) {
            return LocationResponse(
                success = false,
                error = "Location services disabled",
                errorCode = "LOCATION_DISABLED",
                message = "Please enable location services in Settings"
            )
        }
        
        // Set accuracy based on request
        locationManager.desiredAccuracy = when (request.accuracy) {
            LocationAccuracy.HIGH -> kCLLocationAccuracyBest
            LocationAccuracy.MEDIUM -> kCLLocationAccuracyNearestTenMeters
            LocationAccuracy.LOW -> kCLLocationAccuracyHundredMeters
        }
        
        return try {
            val location = requestSingleLocation()
            
            LocationResponse(
                success = true,
                latitude = location.coordinate.useContents { latitude },
                longitude = location.coordinate.useContents { longitude },
                accuracyMeters = location.horizontalAccuracy,
                altitude = location.altitude,
                bearing = location.course.toFloat(),
                speed = location.speed.toFloat(),
                timestamp = (location.timestamp?.timeIntervalSince1970 ?: 0.0).toLong() * 1000,
                address = if (request.includeAddress) {
                    // In a real implementation, you would use CLGeocoder here
                    "iOS Location"
                } else null,
                message = "Location retrieved successfully"
            )
        } catch (e: Exception) {
            LocationResponse(
                success = false,
                error = e.message ?: "Failed to get location",
                errorCode = "LOCATION_ERROR",
                message = "Failed to retrieve location: ${e.message}"
            )
        }
    }
    
    override suspend fun hasLocationPermission(): Boolean {
        return when (CLLocationManager.authorizationStatus()) {
            kCLAuthorizationStatusAuthorizedAlways,
            kCLAuthorizationStatusAuthorizedWhenInUse -> true
            else -> false
        }
    }
    
    override suspend fun isLocationEnabled(): Boolean {
        return CLLocationManager.locationServicesEnabled()
    }
    
    private suspend fun requestSingleLocation(): CLLocation = suspendCancellableCoroutine { cont ->
        delegate.locationCallback = { result ->
            delegate.locationCallback = null
            result.fold(
                onSuccess = { cont.resume(it) },
                onFailure = { cont.resumeWithException(it) }
            )
        }
        
        // Request location authorization if needed
        when (CLLocationManager.authorizationStatus()) {
            kCLAuthorizationStatusNotDetermined -> {
                locationManager.requestWhenInUseAuthorization()
            }
            kCLAuthorizationStatusAuthorizedAlways,
            kCLAuthorizationStatusAuthorizedWhenInUse -> {
                // Permission granted, request location
                locationManager.requestLocation()
            }
            else -> {
                delegate.locationCallback?.invoke(Result.failure(Exception("Location permission denied")))
            }
        }
        
        cont.invokeOnCancellation {
            delegate.locationCallback = null
            locationManager.stopUpdatingLocation()
        }
    }
}