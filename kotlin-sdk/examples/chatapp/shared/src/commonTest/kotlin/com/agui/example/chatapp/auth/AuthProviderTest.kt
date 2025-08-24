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
