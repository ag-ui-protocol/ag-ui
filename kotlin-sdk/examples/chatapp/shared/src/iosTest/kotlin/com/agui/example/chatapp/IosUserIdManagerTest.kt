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