package com.agui.example.chatapp.data.auth

import com.agui.example.chatapp.data.model.AuthMethod

/**
 * Interface for authentication providers that handle different auth methods.
 */
interface AuthProvider {
    /**
     * Checks if this provider can handle the given auth method.
     */
    fun canHandle(authMethod: AuthMethod): Boolean
    
    /**
     * Applies authentication to the request headers.
     */
    suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>)
    
    /**
     * Refreshes the authentication if needed (e.g., for OAuth tokens).
     */
    suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod
    
    /**
     * Validates if the current authentication is still valid.
     */
    suspend fun isAuthValid(authMethod: AuthMethod): Boolean
}
