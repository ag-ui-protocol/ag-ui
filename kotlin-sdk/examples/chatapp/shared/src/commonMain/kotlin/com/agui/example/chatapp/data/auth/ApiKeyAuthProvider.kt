package com.agui.example.chatapp.data.auth

import com.agui.example.chatapp.data.model.AuthMethod

class ApiKeyAuthProvider : AuthProvider {
    override fun canHandle(authMethod: AuthMethod): Boolean {
        return authMethod is AuthMethod.ApiKey
    }
    
    override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
        when (authMethod) {
            is AuthMethod.ApiKey -> {
                headers[authMethod.headerName] = authMethod.key
            }
            else -> throw IllegalArgumentException("Unsupported auth method")
        }
    }
    
    override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod {
        // API keys don't need refreshing
        return authMethod
    }
    
    override suspend fun isAuthValid(authMethod: AuthMethod): Boolean {
        return authMethod is AuthMethod.ApiKey && authMethod.key.isNotBlank()
    }
}