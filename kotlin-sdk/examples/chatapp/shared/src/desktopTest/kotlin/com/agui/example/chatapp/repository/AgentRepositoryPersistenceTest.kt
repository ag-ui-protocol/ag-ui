package com.agui.example.chatapp.repository

import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.test.TestSettings
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.*

/**
 * Tests for AgentRepository persistence functionality.
 * Tests data persistence across repository instances, settings storage/retrieval,
 * and data integrity scenarios.
 */
class AgentRepositoryPersistenceTest {

    private lateinit var settings: TestSettings

    @BeforeTest
    fun setup() {
        AgentRepository.resetInstance()
        settings = TestSettings()
    }

    @AfterTest
    fun tearDown() {
        AgentRepository.resetInstance()
    }

    @Test
    fun testAgentPersistenceAcrossInstances() = runTest {
        // Create first repository instance and add agents
        val repository1 = AgentRepository.getInstance(settings)
        
        val agent1 = AgentConfig(
            id = "persist-1",
            name = "Persistent Agent 1",
            url = "https://agent1.com",
            authMethod = AuthMethod.ApiKey("key1")
        )
        
        val agent2 = AgentConfig(
            id = "persist-2", 
            name = "Persistent Agent 2",
            url = "https://agent2.com",
            authMethod = AuthMethod.BearerToken("token1")
        )

        repository1.addAgent(agent1)
        repository1.addAgent(agent2)
        repository1.setActiveAgent(agent1)

        // Reset instance and create new repository with same settings
        AgentRepository.resetInstance()
        val repository2 = AgentRepository.getInstance(settings)

        // Verify agents were persisted
        val persistedAgents = repository2.agents.value
        assertEquals(2, persistedAgents.size)
        
        val persistedAgent1 = persistedAgents.find { it.id == "persist-1" }
        val persistedAgent2 = persistedAgents.find { it.id == "persist-2" }
        
        assertNotNull(persistedAgent1)
        assertNotNull(persistedAgent2)
        assertEquals("Persistent Agent 1", persistedAgent1.name)
        assertEquals("Persistent Agent 2", persistedAgent2.name)
        assertEquals("https://agent1.com", persistedAgent1.url)
        assertEquals("https://agent2.com", persistedAgent2.url)

        // Verify active agent was persisted
        assertEquals("persist-1", repository2.activeAgent.value?.id)
    }

    @Test
    fun testAuthMethodPersistence() = runTest {
        val repository1 = AgentRepository.getInstance(settings)

        val agentWithApiKey = AgentConfig(
            id = "auth-1",
            name = "API Key Agent",
            url = "https://api.com",
            authMethod = AuthMethod.ApiKey("secret-key", "X-Custom-Key")
        )

        val agentWithBearer = AgentConfig(
            id = "auth-2",
            name = "Bearer Token Agent", 
            url = "https://bearer.com",
            authMethod = AuthMethod.BearerToken("bearer-token-123")
        )

        val agentWithBasic = AgentConfig(
            id = "auth-3",
            name = "Basic Auth Agent",
            url = "https://basic.com",
            authMethod = AuthMethod.BasicAuth("username", "password")
        )

        val agentWithNone = AgentConfig(
            id = "auth-4",
            name = "No Auth Agent",
            url = "https://none.com",
            authMethod = AuthMethod.None()
        )

        repository1.addAgent(agentWithApiKey)
        repository1.addAgent(agentWithBearer)
        repository1.addAgent(agentWithBasic)
        repository1.addAgent(agentWithNone)

        // Create new repository instance
        AgentRepository.resetInstance()
        val repository2 = AgentRepository.getInstance(settings)

        val persistedAgents = repository2.agents.value
        assertEquals(4, persistedAgents.size)

        // Verify API Key auth persistence
        val apiAgent = persistedAgents.find { it.id == "auth-1" }!!
        assertTrue(apiAgent.authMethod is AuthMethod.ApiKey)
        val apiAuth = apiAgent.authMethod as AuthMethod.ApiKey
        assertEquals("secret-key", apiAuth.key)
        assertEquals("X-Custom-Key", apiAuth.headerName)

        // Verify Bearer Token auth persistence
        val bearerAgent = persistedAgents.find { it.id == "auth-2" }!!
        assertTrue(bearerAgent.authMethod is AuthMethod.BearerToken)
        val bearerAuth = bearerAgent.authMethod as AuthMethod.BearerToken
        assertEquals("bearer-token-123", bearerAuth.token)

        // Verify Basic Auth persistence
        val basicAgent = persistedAgents.find { it.id == "auth-3" }!!
        assertTrue(basicAgent.authMethod is AuthMethod.BasicAuth)
        val basicAuth = basicAgent.authMethod as AuthMethod.BasicAuth
        assertEquals("username", basicAuth.username)
        assertEquals("password", basicAuth.password)

        // Verify None auth persistence
        val noneAgent = persistedAgents.find { it.id == "auth-4" }!!
        assertTrue(noneAgent.authMethod is AuthMethod.None)
    }

    @Test
    fun testAgentUpdatePersistence() = runTest {
        val repository1 = AgentRepository.getInstance(settings)

        val originalAgent = AgentConfig(
            id = "update-1",
            name = "Original Name",
            url = "https://original.com",
            authMethod = AuthMethod.ApiKey("original-key")
        )

        repository1.addAgent(originalAgent)
        repository1.setActiveAgent(originalAgent)

        // Update the agent
        val updatedAgent = originalAgent.copy(
            name = "Updated Name",
            url = "https://updated.com",
            authMethod = AuthMethod.BearerToken("updated-token")
        )
        repository1.updateAgent(updatedAgent)

        // Create new repository instance
        AgentRepository.resetInstance()
        val repository2 = AgentRepository.getInstance(settings)

        // Verify updated agent was persisted
        val persistedAgent = repository2.agents.value.find { it.id == "update-1" }!!
        assertEquals("Updated Name", persistedAgent.name)
        assertEquals("https://updated.com", persistedAgent.url)
        assertTrue(persistedAgent.authMethod is AuthMethod.BearerToken)

        // Verify active agent reflects update
        assertEquals("update-1", repository2.activeAgent.value?.id)
        assertEquals("Updated Name", repository2.activeAgent.value?.name)
    }

    @Test
    fun testAgentDeletionPersistence() = runTest {
        val repository1 = AgentRepository.getInstance(settings)

        val agent1 = AgentConfig(id = "delete-1", name = "Keep", url = "https://keep.com")
        val agent2 = AgentConfig(id = "delete-2", name = "Remove", url = "https://remove.com")
        val agent3 = AgentConfig(id = "delete-3", name = "Keep Too", url = "https://keep-too.com")

        repository1.addAgent(agent1)
        repository1.addAgent(agent2)
        repository1.addAgent(agent3)
        repository1.setActiveAgent(agent2)

        // Delete agent2 (which is also active)
        repository1.deleteAgent("delete-2")

        // Create new repository instance
        AgentRepository.resetInstance()
        val repository2 = AgentRepository.getInstance(settings)

        // Verify deletion was persisted
        val persistedAgents = repository2.agents.value
        assertEquals(2, persistedAgents.size)
        assertNull(persistedAgents.find { it.id == "delete-2" })
        assertNotNull(persistedAgents.find { it.id == "delete-1" })
        assertNotNull(persistedAgents.find { it.id == "delete-3" })

        // Verify active agent was cleared when deleted agent was active
        assertNull(repository2.activeAgent.value)
    }

    @Test
    fun testLastUsedTimePersistence() = runTest {
        val repository1 = AgentRepository.getInstance(settings)

        val agent = AgentConfig(
            id = "time-1",
            name = "Time Test Agent",
            url = "https://time.com"
        )

        repository1.addAgent(agent)
        
        val beforeSetActive = Clock.System.now()
        repository1.setActiveAgent(agent)
        val afterSetActive = Clock.System.now()

        // Create new repository instance
        AgentRepository.resetInstance()
        val repository2 = AgentRepository.getInstance(settings)

        // Verify lastUsedAt was persisted and updated
        val persistedAgent = repository2.agents.value.find { it.id == "time-1" }!!
        assertNotNull(persistedAgent.lastUsedAt)
        assertTrue(persistedAgent.lastUsedAt!! >= beforeSetActive)
        assertTrue(persistedAgent.lastUsedAt!! <= afterSetActive)
    }

    @Test
    fun testCorruptedDataHandling() = runTest {
        // Manually corrupt the agents data in settings
        settings.putString("agents", "{invalid json")

        // Create repository - should handle corrupted data gracefully
        val repository = AgentRepository.getInstance(settings)

        // Should start with empty agents list
        assertTrue(repository.agents.value.isEmpty())
        assertNull(repository.activeAgent.value)

        // Should be able to add new agents normally
        val agent = AgentConfig(
            id = "recovery-1",
            name = "Recovery Agent",
            url = "https://recovery.com"
        )

        repository.addAgent(agent)
        assertEquals(1, repository.agents.value.size)
        assertEquals("Recovery Agent", repository.agents.value.first().name)
    }

    @Test
    fun testEmptySettingsInitialization() = runTest {
        // Create repository with empty settings
        val repository = AgentRepository.getInstance(settings)

        // Should initialize with empty state
        assertTrue(repository.agents.value.isEmpty())
        assertNull(repository.activeAgent.value)
        assertNull(repository.currentSession.value)
    }

    @Test
    fun testActiveAgentWithoutMatchingAgent() = runTest {
        // Manually set active agent ID that doesn't match any stored agent
        settings.putString("active_agent", "non-existent-id")
        settings.putString("agents", "[]")

        val repository = AgentRepository.getInstance(settings)

        // Should handle gracefully - no active agent
        assertNull(repository.activeAgent.value)
        assertTrue(repository.agents.value.isEmpty())
    }

    @Test
    fun testLargeNumberOfAgents() = runTest {
        val repository1 = AgentRepository.getInstance(settings)

        // Add 100 agents
        repeat(100) { i ->
            val agent = AgentConfig(
                id = "agent-$i",
                name = "Agent $i",
                url = "https://agent$i.com",
                authMethod = if (i % 2 == 0) {
                    AuthMethod.ApiKey("key-$i")
                } else {
                    AuthMethod.BearerToken("token-$i")
                }
            )
            repository1.addAgent(agent)
        }

        repository1.setActiveAgent(repository1.agents.value.find { it.id == "agent-50" })

        // Create new repository instance
        AgentRepository.resetInstance()
        val repository2 = AgentRepository.getInstance(settings)

        // Verify all agents were persisted
        assertEquals(100, repository2.agents.value.size)
        
        // Verify random agents
        val agent25 = repository2.agents.value.find { it.id == "agent-25" }!!
        assertEquals("Agent 25", agent25.name)
        assertTrue(agent25.authMethod is AuthMethod.BearerToken)

        val agent50 = repository2.agents.value.find { it.id == "agent-50" }!!
        assertEquals("Agent 50", agent50.name)
        assertTrue(agent50.authMethod is AuthMethod.ApiKey)

        // Verify active agent
        assertEquals("agent-50", repository2.activeAgent.value?.id)
    }

    @Test
    fun testConcurrentAccessToSameSettings() = runTest {
        // Test that multiple repository instances with same settings work correctly
        val repository1 = AgentRepository.getInstance(settings)
        
        val agent1 = AgentConfig(id = "concurrent-1", name = "First", url = "https://first.com")
        repository1.addAgent(agent1)

        // Get another instance (should be the same singleton)
        val repository2 = AgentRepository.getInstance(settings)
        
        // Both should see the same data
        assertEquals(1, repository1.agents.value.size)
        assertEquals(1, repository2.agents.value.size)
        assertEquals(repository1.agents.value.first(), repository2.agents.value.first())

        // Changes in one should reflect in the other (same instance)
        val agent2 = AgentConfig(id = "concurrent-2", name = "Second", url = "https://second.com")
        repository2.addAgent(agent2)

        assertEquals(2, repository1.agents.value.size)
        assertEquals(2, repository2.agents.value.size)
    }

    @Test
    fun testSessionPersistenceWithActiveAgent() = runTest {
        val repository1 = AgentRepository.getInstance(settings)

        val agent = AgentConfig(
            id = "session-1",
            name = "Session Agent",
            url = "https://session.com"
        )

        repository1.addAgent(agent)
        repository1.setActiveAgent(agent)

        // Verify session was created
        val session1 = repository1.currentSession.value
        assertNotNull(session1)
        assertEquals("session-1", session1.agentId)
        assertNotNull(session1.threadId)

        // Create new repository instance
        AgentRepository.resetInstance()
        val repository2 = AgentRepository.getInstance(settings)

        // Active agent should be restored but session should be new
        assertEquals("session-1", repository2.activeAgent.value?.id)
        
        // Current session starts fresh (thread IDs are generated per connection)
        assertNull(repository2.currentSession.value)
    }
}