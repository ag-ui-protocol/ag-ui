package com.agui.example.chatapp

import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertNotNull
import kotlin.test.assertNotEquals

/**
 * Improved tests that actually verify meaningful behavior.
 */
class SimpleWorkingTest {

    @Test
    fun testBasicAssertion() {
        assertEquals(4, 2 + 2)
        assertTrue(true)
    }

    @Test
    fun testAgentConfigCreation() {
        val agent = AgentConfig(
            id = "test-123",
            name = "Test Agent",
            url = "https://example.com/agent",
            description = "A test agent",
            authMethod = AuthMethod.None()
        )

        assertEquals("test-123", agent.id)
        assertEquals("Test Agent", agent.name)
        assertEquals("https://example.com/agent", agent.url)
        assertTrue(agent.authMethod is AuthMethod.None)
    }

    @Test
    fun testAuthMethodPolymorphism() {
        // Test that sealed class polymorphism works correctly
        val authMethods: List<AuthMethod> = listOf(
            AuthMethod.None(),
            AuthMethod.ApiKey("test-key", "X-API-Key"),
            AuthMethod.BearerToken("test-token"),
            AuthMethod.BasicAuth("user", "pass")
        )

        // Now these type checks are meaningful because we're working with a polymorphic list
        val none = authMethods[0]
        val apiKey = authMethods[1]
        val bearer = authMethods[2]
        val basic = authMethods[3]

        assertTrue(none is AuthMethod.None)
        assertTrue(apiKey is AuthMethod.ApiKey)
        assertTrue(bearer is AuthMethod.BearerToken)
        assertTrue(basic is AuthMethod.BasicAuth)

        // Test that when statements work correctly (exhaustive)
        authMethods.forEach { method ->
            val result = when (method) {
                is AuthMethod.None -> "none"
                is AuthMethod.ApiKey -> "api_key"
                is AuthMethod.BearerToken -> "bearer"
                is AuthMethod.BasicAuth -> "basic"
                is AuthMethod.OAuth2 -> "oauth2"
                is AuthMethod.Custom -> "custom"
            }
            assertNotNull(result)
        }
    }

    @Test
    fun testAuthMethodProperties() {
        val apiKey = AuthMethod.ApiKey("secret-key", "X-Custom-API-Key")
        val bearer = AuthMethod.BearerToken("bearer-token")
        val basic = AuthMethod.BasicAuth("username", "password")

        // Test that properties are correctly accessible
        assertEquals("secret-key", apiKey.key)
        assertEquals("X-Custom-API-Key", apiKey.headerName)
        assertEquals("bearer-token", bearer.token)
        assertEquals("username", basic.username)
        assertEquals("password", basic.password)
    }

    @Test
    fun testAuthMethodSerialization() {
        val json = Json { ignoreUnknownKeys = true }

        val original = AuthMethod.ApiKey("test-key", "X-API-Key")
        val serialized = json.encodeToString<AuthMethod>(original)
        val deserialized = json.decodeFromString<AuthMethod>(serialized)

        // Test that serialization preserves type and data
        assertEquals(original, deserialized)
        assertTrue(deserialized is AuthMethod.ApiKey)
        assertEquals("test-key", (deserialized as AuthMethod.ApiKey).key)
    }

    @Test
    fun testAgentConfigEquality() {
        val now = kotlinx.datetime.Clock.System.now()
        
        val agent1 = AgentConfig(
            id = "same-id",
            name = "Agent",
            url = "https://test.com",
            authMethod = AuthMethod.None(),
            createdAt = now
        )

        val agent2 = AgentConfig(
            id = "same-id",
            name = "Agent",
            url = "https://test.com",
            authMethod = AuthMethod.None(),
            createdAt = now
        )

        val agent3 = AgentConfig(
            id = "different-id",
            name = "Agent",
            url = "https://test.com",
            authMethod = AuthMethod.None(),
            createdAt = now
        )

        // Test data class equality
        assertEquals(agent1, agent2)
        assertNotEquals(agent1, agent3)
    }

    @Test
    fun testAuthMethodFactoryMethods() {
        // Test that different auth methods can be created with default values
        val none = AuthMethod.None()
        val apiKeyWithDefaults = AuthMethod.ApiKey("key")
        val bearerToken = AuthMethod.BearerToken("token")
        val basicAuth = AuthMethod.BasicAuth("user", "pass")

        // Verify default values are applied correctly
        assertEquals("X-API-Key", apiKeyWithDefaults.headerName)
        assertEquals("none", none.id)

        // Test that each auth method has the expected properties
        assertEquals("key", apiKeyWithDefaults.key)
        assertEquals("token", bearerToken.token)
        assertEquals("user", basicAuth.username)
        assertEquals("pass", basicAuth.password)

        // Test that factory methods with different parameters create different values
        val apiKey1 = AuthMethod.ApiKey("key1")
        val apiKey2 = AuthMethod.ApiKey("key2")
        assertEquals("key1", apiKey1.key)
        assertEquals("key2", apiKey2.key)

        // Test that custom header names work
        val customHeaderApiKey = AuthMethod.ApiKey("secret", "X-Custom-Header")
        assertEquals("secret", customHeaderApiKey.key)
        assertEquals("X-Custom-Header", customHeaderApiKey.headerName)

        // Test that None instances with same id are equal
        val none1 = AuthMethod.None()
        val none2 = AuthMethod.None()
        assertEquals(none1, none2)
    }

    @Test
    fun testAgentConfigIdGeneration() {
        val id1 = AgentConfig.generateId()
        val id2 = AgentConfig.generateId()

        // Test that generated IDs are different
        assertNotEquals(id1, id2)

        // Test that IDs follow expected pattern
        assertTrue(id1.startsWith("agent_"))
        assertTrue(id2.startsWith("agent_"))

        // Test that IDs are not empty
        assertTrue(id1.length > "agent_".length)
        assertTrue(id2.length > "agent_".length)
    }
}