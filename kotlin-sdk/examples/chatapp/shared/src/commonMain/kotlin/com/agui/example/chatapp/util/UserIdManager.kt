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