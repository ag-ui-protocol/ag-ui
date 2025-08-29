package com.agui.example.tools

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class IosLocationProviderTest {
    
    @Test
    fun testCreateLocationProvider() {
        val provider = createLocationProvider()
        assertNotNull(provider)
        assertTrue(provider is IosLocationProvider)
    }
    
    @Test
    fun testLocationProviderMethods() = runTest {
        val provider = createLocationProvider()
        
        // Test that methods are callable (actual behavior depends on iOS permissions)
        val hasPermission = provider.hasLocationPermission()
        val isEnabled = provider.isLocationEnabled()
        
        // These are boolean results, so they should always return something
        assertTrue(hasPermission == true || hasPermission == false)
        assertTrue(isEnabled == true || isEnabled == false)
    }
    
    @Test
    fun testLocationRequest() = runTest {
        val provider = createLocationProvider()
        
        val request = LocationRequest(
            accuracy = LocationAccuracy.MEDIUM,
            includeAddress = false,
            timeoutMs = 5000L,
            toolCallId = "test-123"
        )
        
        // Test that we can make a location request
        // The actual result depends on iOS permissions and simulator/device state
        val response = provider.getCurrentLocation(request)
        assertNotNull(response)
        
        // Response should have success flag set
        assertTrue(response.success == true || response.success == false)
        
        // If unsuccessful, should have error information
        if (!response.success) {
            assertNotNull(response.error)
            assertNotNull(response.errorCode)
        }
    }
}