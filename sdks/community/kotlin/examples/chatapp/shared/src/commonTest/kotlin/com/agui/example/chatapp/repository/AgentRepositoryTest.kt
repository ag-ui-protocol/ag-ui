package com.agui.example.chatapp.repository

import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.test.TestSettings
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class AgentRepositoryTest {
    
    private lateinit var settings: TestSettings
    private lateinit var repository: AgentRepository

    @BeforeTest
    fun setup() {
        // Reset the singleton instance to ensure clean state
        AgentRepository.resetInstance()

        settings = TestSettings()
        repository = AgentRepository.getInstance(settings)
    }

    @AfterTest
    fun tearDown() {
        // Clean up after each test
        AgentRepository.resetInstance()
    }
    
    @Test
    fun testAddAgent() = runTest {
        val agent = AgentConfig(
            id = "test-1",
            name = "Test Agent",
            url = "https://test.com/agent",
            authMethod = AuthMethod.None()
        )
        
        repository.addAgent(agent)
        
        val agents = repository.agents.value
        assertEquals(1, agents.size)
        assertEquals(agent, agents.first())
    }
    
    @Test
    fun testUpdateAgent() = runTest {
        val agent = AgentConfig(
            id = "test-1",
            name = "Test Agent",
            url = "https://test.com/agent"
        )
        
        repository.addAgent(agent)
        
        val updatedAgent = agent.copy(name = "Updated Agent")
        repository.updateAgent(updatedAgent)
        
        val agents = repository.agents.value
        assertEquals(1, agents.size)
        assertEquals("Updated Agent", agents.first().name)
    }
    
    @Test
    fun testDeleteAgent() = runTest {
        val agent1 = AgentConfig(id = "1", name = "Agent 1", url = "https://test1.com")
        val agent2 = AgentConfig(id = "2", name = "Agent 2", url = "https://test2.com")
        
        repository.addAgent(agent1)
        repository.addAgent(agent2)
        
        assertEquals(2, repository.agents.value.size)
        
        repository.deleteAgent("1")
        
        val agents = repository.agents.value
        assertEquals(1, agents.size)
        assertEquals("2", agents.first().id)
    }
    
    @Test
    fun testSetActiveAgent() = runTest {
        val agent = AgentConfig(
            id = "test-1",
            name = "Test Agent",
            url = "https://test.com/agent"
        )
        
        repository.addAgent(agent)
        repository.setActiveAgent(agent)
        
        assertEquals(agent.id, repository.activeAgent.value?.id)
        assertNotNull(repository.currentSession.value)
    }

    @Test
    fun testAddAgentWithSystemPrompt() = runTest {
        val agent = AgentConfig(
            id = "test-with-prompt",
            name = "Test Agent with System Prompt",
            url = "https://test.com/agent",
            systemPrompt = "You are a helpful AI assistant specializing in testing."
        )
        
        repository.addAgent(agent)
        
        val agents = repository.agents.value
        assertEquals(1, agents.size)
        val savedAgent = agents.first()
        assertEquals(agent.systemPrompt, savedAgent.systemPrompt)
        assertEquals("You are a helpful AI assistant specializing in testing.", savedAgent.systemPrompt)
    }

    @Test
    fun testUpdateAgentSystemPrompt() = runTest {
        val agent = AgentConfig(
            id = "test-prompt-update",
            name = "Test Agent",
            url = "https://test.com/agent",
            systemPrompt = "Initial system prompt"
        )
        
        repository.addAgent(agent)
        
        val updatedAgent = agent.copy(
            systemPrompt = "Updated system prompt with new instructions"
        )
        repository.updateAgent(updatedAgent)
        
        val agents = repository.agents.value
        assertEquals(1, agents.size)
        assertEquals("Updated system prompt with new instructions", agents.first().systemPrompt)
    }

    @Test
    fun testAgentWithNullSystemPrompt() = runTest {
        val agent = AgentConfig(
            id = "test-null-prompt",
            name = "Test Agent",
            url = "https://test.com/agent",
            systemPrompt = null
        )
        
        repository.addAgent(agent)
        
        val agents = repository.agents.value
        assertEquals(1, agents.size)
        assertNull(agents.first().systemPrompt)
    }

    @Test
    fun testRemoveSystemPromptFromAgent() = runTest {
        val agent = AgentConfig(
            id = "test-remove-prompt",
            name = "Test Agent",
            url = "https://test.com/agent",
            systemPrompt = "This prompt will be removed"
        )
        
        repository.addAgent(agent)
        assertEquals("This prompt will be removed", repository.agents.value.first().systemPrompt)
        
        val updatedAgent = agent.copy(systemPrompt = null)
        repository.updateAgent(updatedAgent)
        
        val agents = repository.agents.value
        assertEquals(1, agents.size)
        assertNull(agents.first().systemPrompt)
    }

    @Test
    fun testSystemPromptPersistenceWithComplexAgent() = runTest {
        val complexPrompt = """
            You are an AI assistant with the following characteristics:
            1. Be helpful and informative
            2. Use a professional tone
            3. Provide concise but complete answers
            4. Always verify facts before stating them
            
            When responding to technical questions, structure your answers with:
            - Brief explanation
            - Code examples when relevant
            - Additional resources if helpful
        """.trimIndent()
        
        val agent = AgentConfig(
            id = "complex-agent",
            name = "Complex Test Agent",
            url = "https://test.com/complex-agent",
            description = "Agent with complex system prompt",
            authMethod = AuthMethod.ApiKey("secret-key", "X-API-Key"),
            systemPrompt = complexPrompt,
            customHeaders = mapOf("X-Custom" to "test-value")
        )
        
        repository.addAgent(agent)
        
        val savedAgent = repository.agents.value.first()
        assertEquals(complexPrompt, savedAgent.systemPrompt)
        assertEquals(agent.authMethod, savedAgent.authMethod)
        assertEquals(agent.customHeaders, savedAgent.customHeaders)
    }
}
