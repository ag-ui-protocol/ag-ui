package com.agui.example.chatapp.data.auth

import com.agui.example.chatapp.data.model.AuthMethod

class BearerTokenAuthProvider : AuthProvider {
    override fun canHandle(authMethod: AuthMethod): Boolean {
        return authMethod is AuthMethod.BearerToken
    }
    
    override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
        when (authMethod) {
            is AuthMethod.BearerToken -> {
                headers["Authorization"] = "Bearer ${authMethod.token}"
            }
            else -> throw IllegalArgumentException("Unsupported auth method")
        }
    }
    
    override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod {
        // Simple bearer tokens don't refresh themselves
        // OAuth2 provider handles refreshable tokens
        return authMethod
    }
    
    override suspend fun isAuthValid(authMethod: AuthMethod): Boolean {
        return authMethod is AuthMethod.BearerToken && authMethod.token.isNotBlank()
    }
}
