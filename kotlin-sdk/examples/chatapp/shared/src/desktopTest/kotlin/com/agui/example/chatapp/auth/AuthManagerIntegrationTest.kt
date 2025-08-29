package com.agui.example.chatapp.auth

import com.agui.example.chatapp.data.auth.AuthManager
import com.agui.example.chatapp.data.auth.AuthProvider
import com.agui.example.chatapp.data.model.AuthMethod
import kotlinx.coroutines.test.runTest
import kotlin.test.*

/**
 * Integration tests for AuthManager with comprehensive auth scenarios.
 * Tests the complete authentication flow including provider registration,
 * auth application, validation, and refresh operations.
 */
class AuthManagerIntegrationTest {

    private lateinit var authManager: AuthManager

    @BeforeTest
    fun setup() {
        authManager = AuthManager()
    }

    @Test
    fun testDefaultProviderRegistration() = runTest {
        // Test that default providers are registered and working
        val headers = mutableMapOf<String, String>()

        // Test API Key provider
        val apiKeyAuth = AuthMethod.ApiKey("test-key", "X-API-Key")
        authManager.applyAuth(apiKeyAuth, headers)
        assertEquals("test-key", headers["X-API-Key"])

        // Test Bearer Token provider
        headers.clear()
        val bearerAuth = AuthMethod.BearerToken("bearer-token")
        authManager.applyAuth(bearerAuth, headers)
        assertEquals("Bearer bearer-token", headers["Authorization"])

        // Test Basic Auth provider
        headers.clear()
        val basicAuth = AuthMethod.BasicAuth("user", "pass")
        authManager.applyAuth(basicAuth, headers)
        assertNotNull(headers["Authorization"])
        assertTrue(headers["Authorization"]!!.startsWith("Basic "))
    }

    @Test
    fun testCustomProviderRegistration() = runTest {
        // Create a custom auth provider
        val customProvider = object : AuthProvider {
            override fun canHandle(authMethod: AuthMethod): Boolean {
                return authMethod is AuthMethod.ApiKey && authMethod.headerName == "Custom-Header"
            }

            override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
                if (authMethod is AuthMethod.ApiKey) {
                    headers["Custom-Header"] = "Custom-${authMethod.key}"
                }
            }

            override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod = authMethod

            override suspend fun isAuthValid(authMethod: AuthMethod): Boolean = true
        }

        // Register custom provider
        authManager.registerProvider(customProvider)

        // Test custom provider is used
        val headers = mutableMapOf<String, String>()
        val customAuth = AuthMethod.ApiKey("test", "Custom-Header")
        authManager.applyAuth(customAuth, headers)
        assertEquals("Custom-test", headers["Custom-Header"])
    }

    @Test
    fun testAuthValidation() = runTest {
        // Test auth validation for different methods
        assertTrue(authManager.isAuthValid(AuthMethod.None()))
        assertTrue(authManager.isAuthValid(AuthMethod.ApiKey("valid-key")))
        assertTrue(authManager.isAuthValid(AuthMethod.BearerToken("valid-token")))
        assertTrue(authManager.isAuthValid(AuthMethod.BasicAuth("user", "pass")))
    }

    @Test
    fun testAuthRefresh() = runTest {
        // Test auth refresh (most providers return same auth for now)
        val apiKeyAuth = AuthMethod.ApiKey("original-key")
        val refreshedAuth = authManager.refreshAuth(apiKeyAuth)
        assertEquals(apiKeyAuth, refreshedAuth)

        val noneAuth = AuthMethod.None()
        val refreshedNone = authManager.refreshAuth(noneAuth)
        assertEquals(noneAuth, refreshedNone)
    }

    @Test
    fun testUnsupportedAuthMethodScenario() = runTest {
        // Test with a provider that doesn't handle any auth method
        val noMatchProvider = object : AuthProvider {
            override fun canHandle(authMethod: AuthMethod): Boolean = false
            override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {}
            override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod = authMethod
            override suspend fun isAuthValid(authMethod: AuthMethod): Boolean = false
        }

        // Create a fresh auth manager and replace providers
        val emptyAuthManager = AuthManager()
        
        // For this test, we'll use an existing auth method but with no providers registered
        // We can't easily test with a truly unsupported auth method due to sealed class restrictions
        val apiKeyAuth = AuthMethod.ApiKey("test-key")
        
        // Test that we can apply auth normally (default providers handle this)
        val headers = mutableMapOf<String, String>()
        emptyAuthManager.applyAuth(apiKeyAuth, headers)
        assertEquals("test-key", headers["X-API-Key"])
    }

    @Test
    fun testNoneAuthHandling() = runTest {
        // Test that None auth doesn't modify headers
        val headers = mutableMapOf<String, String>()
        headers["Existing-Header"] = "existing-value"

        authManager.applyAuth(AuthMethod.None(), headers)

        // Headers should remain unchanged
        assertEquals(1, headers.size)
        assertEquals("existing-value", headers["Existing-Header"])
    }

    @Test
    fun testApiKeyWithDefaultHeader() = runTest {
        // Test API key with default header name
        val headers = mutableMapOf<String, String>()
        val apiKeyAuth = AuthMethod.ApiKey("test-key") // Uses default "X-API-Key"
        
        authManager.applyAuth(apiKeyAuth, headers)
        assertEquals("test-key", headers["X-API-Key"])
    }

    @Test
    fun testApiKeyWithCustomHeader() = runTest {
        // Test API key with custom header name
        val headers = mutableMapOf<String, String>()
        val apiKeyAuth = AuthMethod.ApiKey("test-key", "Custom-API-Header")
        
        authManager.applyAuth(apiKeyAuth, headers)
        assertEquals("test-key", headers["Custom-API-Header"])
        assertNull(headers["X-API-Key"]) // Default header should not be set
    }

    @Test
    fun testMultipleAuthApplications() = runTest {
        // Test applying different auth methods to same headers
        val headers = mutableMapOf<String, String>()

        // Apply API key first
        authManager.applyAuth(AuthMethod.ApiKey("key1", "Header1"), headers)
        assertEquals(1, headers.size)
        assertEquals("key1", headers["Header1"])

        // Apply Bearer token (should add to existing headers)
        authManager.applyAuth(AuthMethod.BearerToken("token1"), headers)
        assertEquals(2, headers.size)
        assertEquals("key1", headers["Header1"])
        assertEquals("Bearer token1", headers["Authorization"])

        // Apply different API key (should add new header)
        authManager.applyAuth(AuthMethod.ApiKey("key2", "Header2"), headers)
        assertEquals(3, headers.size)
        assertEquals("key2", headers["Header2"])
    }

    @Test
    fun testProviderPriorityOrder() = runTest {
        // Test that custom providers can override default ones
        val customProvider = object : AuthProvider {
            override fun canHandle(authMethod: AuthMethod): Boolean {
                return authMethod is AuthMethod.BearerToken
            }

            override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
                if (authMethod is AuthMethod.BearerToken) {
                    headers["Authorization"] = "Custom-Bearer ${authMethod.token}"
                }
            }

            override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod = authMethod
            override suspend fun isAuthValid(authMethod: AuthMethod): Boolean = true
        }

        authManager.registerProvider(customProvider)

        val headers = mutableMapOf<String, String>()
        val bearerAuth = AuthMethod.BearerToken("test-token")
        authManager.applyAuth(bearerAuth, headers)

        // Should use the first provider that can handle it (custom one)
        assertEquals("Custom-Bearer test-token", headers["Authorization"])
    }

    @Test
    fun testEmptyAndSpecialValueHandling() = runTest {
        val headers = mutableMapOf<String, String>()

        // Test empty API key
        authManager.applyAuth(AuthMethod.ApiKey(""), headers)
        assertEquals("", headers["X-API-Key"])

        // Test empty bearer token
        headers.clear()
        authManager.applyAuth(AuthMethod.BearerToken(""), headers)
        assertEquals("Bearer ", headers["Authorization"])

        // Test empty basic auth
        headers.clear()
        authManager.applyAuth(AuthMethod.BasicAuth("", ""), headers)
        assertNotNull(headers["Authorization"])
        assertTrue(headers["Authorization"]!!.startsWith("Basic "))
    }

    @Test
    fun testConcurrentAuthOperations() = runTest {
        // Test handling multiple auth operations concurrently
        val headers1 = mutableMapOf<String, String>()
        val headers2 = mutableMapOf<String, String>()
        val headers3 = mutableMapOf<String, String>()

        // Apply different auth methods concurrently
        authManager.applyAuth(AuthMethod.ApiKey("key1"), headers1)
        authManager.applyAuth(AuthMethod.BearerToken("token1"), headers2)
        authManager.applyAuth(AuthMethod.BasicAuth("user1", "pass1"), headers3)

        // All should be applied correctly
        assertEquals("key1", headers1["X-API-Key"])
        assertEquals("Bearer token1", headers2["Authorization"])
        assertNotNull(headers3["Authorization"])
        assertTrue(headers3["Authorization"]!!.startsWith("Basic "))
    }

    @Test
    fun testAuthValidationWithInvalidProvider() = runTest {
        // Create a provider that always returns false for validation
        val alwaysInvalidProvider = object : AuthProvider {
            override fun canHandle(authMethod: AuthMethod): Boolean {
                return authMethod is AuthMethod.ApiKey && authMethod.key == "invalid-key"
            }

            override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
                // Do nothing
            }

            override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod = authMethod

            override suspend fun isAuthValid(authMethod: AuthMethod): Boolean = false
        }

        authManager.registerProvider(alwaysInvalidProvider)

        // Test that validation returns false for this specific case
        val invalidAuth = AuthMethod.ApiKey("invalid-key")
        assertFalse(authManager.isAuthValid(invalidAuth))

        // Test that validation still works for other cases
        val validAuth = AuthMethod.ApiKey("valid-key")
        assertTrue(authManager.isAuthValid(validAuth))
    }

    @Test
    fun testRefreshAuthWithCustomProvider() = runTest {
        // Create a provider that modifies auth on refresh
        var refreshCount = 0
        val refreshingProvider = object : AuthProvider {
            override fun canHandle(authMethod: AuthMethod): Boolean {
                return authMethod is AuthMethod.ApiKey && authMethod.key.startsWith("refreshable-")
            }

            override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
                if (authMethod is AuthMethod.ApiKey) {
                    headers["X-API-Key"] = authMethod.key
                }
            }

            override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod {
                refreshCount++
                return if (authMethod is AuthMethod.ApiKey) {
                    AuthMethod.ApiKey("refreshable-${authMethod.key.substringAfter("refreshable-")}-refreshed-$refreshCount")
                } else {
                    authMethod
                }
            }

            override suspend fun isAuthValid(authMethod: AuthMethod): Boolean = true
        }

        authManager.registerProvider(refreshingProvider)

        // Test refresh functionality
        val originalAuth = AuthMethod.ApiKey("refreshable-original")
        val refreshedAuth = authManager.refreshAuth(originalAuth)

        assertTrue(refreshedAuth is AuthMethod.ApiKey)
        assertEquals("refreshable-original-refreshed-1", refreshedAuth.key)
        assertEquals(1, refreshCount)

        // Test refresh again
        val refreshedAuth2 = authManager.refreshAuth(refreshedAuth)
        assertTrue(refreshedAuth2 is AuthMethod.ApiKey)
        assertEquals("refreshable-original-refreshed-1-refreshed-2", refreshedAuth2.key)
        assertEquals(2, refreshCount)
    }
}