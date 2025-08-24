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
package com.agui.example.chatapp.util

import com.russhwolf.settings.Settings
import kotlinx.datetime.Clock
import kotlin.random.Random
import kotlinx.atomicfu.atomic

/**
 * Manages persistent user IDs across app sessions and agent switches.
 * Ensures a consistent user identity throughout the app lifecycle.
 */
class UserIdManager(private val settings: Settings) {
    
    companion object {
        private const val USER_ID_KEY = "persistent_user_id"
        private const val USER_ID_PREFIX = "user"
        
        private val instance = atomic<UserIdManager?>(null)
        
        fun getInstance(settings: Settings): UserIdManager {
            return instance.value ?: run {
                val newInstance = UserIdManager(settings)
                if (instance.compareAndSet(null, newInstance)) {
                    newInstance
                } else {
                    instance.value!!
                }
            }
        }
    }
    
    /**
     * Gets the persistent user ID, generating one if it doesn't exist.
     * This ID persists across app sessions and agent switches.
     */
    fun getUserId(): String {
        return settings.getStringOrNull(USER_ID_KEY) ?: generateAndStoreUserId()
    }
    
    /**
     * Generates a new user ID and stores it persistently.
     */
    private fun generateAndStoreUserId(): String {
        // Generate a unique user ID with timestamp and random component
        val timestamp = Clock.System.now().toEpochMilliseconds()
        val randomComponent = Random.nextInt(10000, 99999)
        val userId = "${USER_ID_PREFIX}_${timestamp}_${randomComponent}"
        
        // Store it persistently
        settings.putString(USER_ID_KEY, userId)
        
        return userId
    }
    
    /**
     * Clears the stored user ID (useful for testing or user logout).
     * A new ID will be generated on the next getUserId() call.
     */
    fun clearUserId() {
        settings.remove(USER_ID_KEY)
    }
    
    /**
     * Checks if a user ID already exists.
     */
    fun hasUserId(): Boolean {
        return settings.getStringOrNull(USER_ID_KEY) != null
    }
}