package com.agui.example.chatapp.data.auth

import com.agui.example.chatapp.data.model.AuthMethod

/**
 * Manages authentication providers and delegates auth operations.
 */
class AuthManager {
    private val providers = mutableListOf<AuthProvider>()
    
    init {
        // Register default providers
        providers.add(ApiKeyAuthProvider())
        providers.add(BearerTokenAuthProvider())
        providers.add(BasicAuthProvider())
        // OAuth2Provider would be added here when implemented
    }
    
    fun registerProvider(provider: AuthProvider) {
        // Add custom providers at the beginning to give them priority over default providers
        providers.add(0, provider)
    }
    
    suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
        if (authMethod is AuthMethod.None) return
        
        val provider = providers.find { it.canHandle(authMethod) }
            ?: throw IllegalArgumentException("No provider found for auth method: $authMethod")
        
        provider.applyAuth(authMethod, headers)
    }
    
    suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod {
        if (authMethod is AuthMethod.None) return authMethod
        
        val provider = providers.find { it.canHandle(authMethod) }
            ?: return authMethod
        
        return provider.refreshAuth(authMethod)
    }
    
    suspend fun isAuthValid(authMethod: AuthMethod): Boolean {
        if (authMethod is AuthMethod.None) return true
        
        val provider = providers.find { it.canHandle(authMethod) }
            ?: return false
        
        return provider.isAuthValid(authMethod)
    }
}