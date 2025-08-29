package com.agui.example.chatapp

import com.agui.example.chatapp.util.UserIdManager
import com.agui.example.chatapp.util.getPlatformSettings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse

class IosUserIdManagerTest {
    
    @Test
    fun testUserIdManagerOnIos() {
        val settings = getPlatformSettings()
        val userIdManager = UserIdManager.getInstance(settings)
        
        assertNotNull(userIdManager)
        
        // Clear any existing ID for clean test
        userIdManager.clearUserId()
        assertFalse(userIdManager.hasUserId())
        
        // Generate new ID
        val userId = userIdManager.getUserId()
        assertNotNull(userId)
        assertTrue(userId.startsWith("user_"))
        assertTrue(userIdManager.hasUserId())
        
        // Verify persistence
        val userId2 = userIdManager.getUserId()
        assertEquals(userId, userId2)
        
        // Test clearing
        userIdManager.clearUserId()
        assertFalse(userIdManager.hasUserId())
        
        // New ID should be different
        val userId3 = userIdManager.getUserId()
        assertNotNull(userId3)
        assertTrue(userId3 != userId)
    }
    
    @Test
    fun testUserIdManagerSingleton() {
        val settings = getPlatformSettings()
        val instance1 = UserIdManager.getInstance(settings)
        val instance2 = UserIdManager.getInstance(settings)
        
        // Should be the same instance
        assertTrue(instance1 === instance2)
    }
}