package com.agui.example.chatapp.auth

import com.agui.example.chatapp.data.auth.ApiKeyAuthProvider
import com.agui.example.chatapp.data.auth.AuthManager
import com.agui.example.chatapp.data.auth.BasicAuthProvider
import com.agui.example.chatapp.data.auth.BearerTokenAuthProvider
import com.agui.example.chatapp.data.model.AuthMethod
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class AuthProviderTest {
    
    @Test
    fun testApiKeyAuthProvider() = runTest {
        val provider = ApiKeyAuthProvider()
        val authMethod = AuthMethod.ApiKey(
            key = "test-api-key",
            headerName = "X-Custom-API-Key"
        )
        
        assertTrue(provider.canHandle(authMethod))
        
        val headers = mutableMapOf<String, String>()
        provider.applyAuth(authMethod, headers)
        
        assertEquals("test-api-key", headers["X-Custom-API-Key"])
        assertTrue(provider.isAuthValid(authMethod))
    }
    
    @Test
    fun testBearerTokenAuthProvider() = runTest {
        val provider = BearerTokenAuthProvider()
        val authMethod = AuthMethod.BearerToken(token = "test-token")
        
        assertTrue(provider.canHandle(authMethod))
        
        val headers = mutableMapOf<String, String>()
        provider.applyAuth(authMethod, headers)
        
        assertEquals("Bearer test-token", headers["Authorization"])
    }
    
    @Test
    fun testBasicAuthProvider() = runTest {
        val provider = BasicAuthProvider()
        val authMethod = AuthMethod.BasicAuth(
            username = "user",
            password = "pass"
        )
        
        assertTrue(provider.canHandle(authMethod))
        
        val headers = mutableMapOf<String, String>()
        provider.applyAuth(authMethod, headers)
        
        // Basic auth should be base64 encoded
        assertNotNull(headers["Authorization"])
        assertTrue(headers["Authorization"]!!.startsWith("Basic "))
    }
    
    @Test
    fun testAuthManager() = runTest {
        val authManager = AuthManager()
        
        // Test with API key
        val apiKeyAuth = AuthMethod.ApiKey(key = "key", headerName = "X-API-Key")
        val headers = mutableMapOf<String, String>()
        
        authManager.applyAuth(apiKeyAuth, headers)
        assertEquals("key", headers["X-API-Key"])
        
        // Test with None auth
        headers.clear()
        authManager.applyAuth(AuthMethod.None(), headers)
        assertTrue(headers.isEmpty())
    }
}
