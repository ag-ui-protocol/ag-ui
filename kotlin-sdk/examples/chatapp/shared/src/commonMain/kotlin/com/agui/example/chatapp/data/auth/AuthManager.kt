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