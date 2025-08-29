package com.agui.example.chatapp.viewmodel

import com.agui.example.chatapp.ui.screens.chat.MessageRole
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.test.TestSettings
import com.agui.example.chatapp.test.TestChatViewModel
import com.agui.example.chatapp.ui.screens.chat.DisplayMessage
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class ChatViewModelTest {

    private lateinit var testSettings: TestSettings
    private lateinit var agentRepository: AgentRepository
    private lateinit var viewModel: TestChatViewModel

    @BeforeTest
    fun setup() {
        // Reset singleton instances
        AgentRepository.resetInstance()

        testSettings = TestSettings()
        agentRepository = AgentRepository.getInstance(testSettings)
        viewModel = TestChatViewModel()
    }

    @AfterTest
    fun tearDown() {
        // Clean up
        AgentRepository.resetInstance()
    }

    @Test
    fun testInitialState() = runTest {
        // Create a test view model with a mock agent
        val testAgent = AgentConfig(
            id = "test-1",
            name = "Test Agent",
            url = "https://test.com/agent",
            authMethod = AuthMethod.None()
        )

        // Add agent to repository
        agentRepository.addAgent(testAgent)
        agentRepository.setActiveAgent(testAgent)

        // Wait for state updates
        delay(100)

        // Verify active agent is set
        val activeAgent = agentRepository.activeAgent.value
        assertNotNull(activeAgent)
        assertEquals("Test Agent", activeAgent.name)
    }

    @Test
    fun testAgentRepository() = runTest {
        val agent = AgentConfig(
            id = "test-1",
            name = "Test Agent",
            url = "https://test.com/agent",
            authMethod = AuthMethod.None()
        )

        // Test adding agent
        agentRepository.addAgent(agent)
        val agents = agentRepository.agents.value
        assertEquals(1, agents.size)
        assertEquals(agent, agents.first())

        // Test setting active agent
        agentRepository.setActiveAgent(agent)
        val activeAgent = agentRepository.activeAgent.value
        assertEquals(agent.id, activeAgent?.id)

        // Test session creation
        val session = agentRepository.currentSession.value
        assertNotNull(session)
        assertEquals(agent.id, session.agentId)
    }

    @Test
    fun testMessageFormatting() {
        val userMessage = DisplayMessage(
            id = "1",
            role = MessageRole.USER,
            content = "Hello, agent!"
        )

        assertEquals("1", userMessage.id)
        assertEquals(MessageRole.USER, userMessage.role)
        assertEquals("Hello, agent!", userMessage.content)
        assertFalse(userMessage.isStreaming)
    }

    @Test
    fun testStreamingMessage() {
        val streamingMessage = DisplayMessage(
            id = "2",
            role = MessageRole.ASSISTANT,
            content = "Thinking...",
            isStreaming = true
        )

        assertEquals("2", streamingMessage.id)
        assertEquals(MessageRole.ASSISTANT, streamingMessage.role)
        assertEquals("Thinking...", streamingMessage.content)
        assertTrue(streamingMessage.isStreaming)
    }

    @Test
    fun testAgentWithSystemPrompt() = runTest {
        val testAgent = AgentConfig(
            id = "test-system-prompt",
            name = "Test Agent with System Prompt",
            url = "https://test.com/agent",
            authMethod = AuthMethod.None(),
            systemPrompt = "You are a helpful AI assistant specializing in unit testing."
        )

        // Add agent to repository
        agentRepository.addAgent(testAgent)
        agentRepository.setActiveAgent(testAgent)

        // Wait for state updates
        delay(100)

        // Verify active agent has system prompt
        val activeAgent = agentRepository.activeAgent.value
        assertNotNull(activeAgent)
        assertEquals("You are a helpful AI assistant specializing in unit testing.", activeAgent.systemPrompt)
    }

    @Test
    fun testAgentWithoutSystemPrompt() = runTest {
        val testAgent = AgentConfig(
            id = "test-no-prompt",
            name = "Test Agent without System Prompt",
            url = "https://test.com/agent",
            authMethod = AuthMethod.None(),
            systemPrompt = null
        )

        // Add agent to repository
        agentRepository.addAgent(testAgent)
        agentRepository.setActiveAgent(testAgent)

        // Wait for state updates
        delay(100)

        // Verify active agent has no system prompt
        val activeAgent = agentRepository.activeAgent.value
        assertNotNull(activeAgent)
        assertNull(activeAgent.systemPrompt)
    }

    @Test
    fun testSystemPromptUpdatePropagation() = runTest {
        val initialAgent = AgentConfig(
            id = "test-update-prompt",
            name = "Test Agent",
            url = "https://test.com/agent",
            systemPrompt = "Initial system prompt"
        )

        // Add initial agent
        agentRepository.addAgent(initialAgent)
        agentRepository.setActiveAgent(initialAgent)
        delay(100)

        // Verify initial system prompt
        assertEquals("Initial system prompt", agentRepository.activeAgent.value?.systemPrompt)

        // Update agent with new system prompt
        val updatedAgent = initialAgent.copy(
            systemPrompt = "Updated system prompt with new behavior"
        )
        agentRepository.updateAgent(updatedAgent)

        // Verify the system prompt is updated
        val agents = agentRepository.agents.value
        val savedAgent = agents.find { it.id == "test-update-prompt" }
        assertNotNull(savedAgent)
        assertEquals("Updated system prompt with new behavior", savedAgent.systemPrompt)
    }

    @Test
    fun testComplexSystemPromptHandling() = runTest {
        val complexPrompt = """
            System Instructions:
            
            You are a specialized AI assistant for software testing. Follow these guidelines:
            
            1. Always validate inputs before processing
            2. Provide clear, actionable feedback
            3. Include relevant code examples when helpful
            4. Maintain a professional but friendly tone
            
            Special behaviors:
            - For test failures: Suggest specific debugging steps
            - For performance issues: Recommend profiling tools
            - For integration tests: Focus on boundary conditions
            
            Remember to always consider edge cases and error scenarios.
        """.trimIndent()

        val testAgent = AgentConfig(
            id = "complex-prompt-agent",
            name = "Complex System Prompt Agent",
            url = "https://test.com/agent",
            authMethod = AuthMethod.BearerToken("test-token"),
            systemPrompt = complexPrompt
        )

        agentRepository.addAgent(testAgent)
        agentRepository.setActiveAgent(testAgent)
        delay(100)

        val activeAgent = agentRepository.activeAgent.value
        assertNotNull(activeAgent)
        assertEquals(complexPrompt, activeAgent.systemPrompt)
        assertTrue(activeAgent.systemPrompt!!.contains("System Instructions:"))
        assertTrue(activeAgent.systemPrompt!!.contains("edge cases"))
    }

    @Test
    fun testSystemPromptWithSpecialCharacters() = runTest {
        val promptWithSpecialChars = """
            System prompt with "quotes", 'single quotes', and symbols: @#$%^&*()
            Multiple lines with	tabs and   spaces
            Unicode: 🤖 emoji and special chars: ñáéíóú
            JSON-like structure: {"role": "assistant", "behavior": "helpful"}
        """.trimIndent()

        val testAgent = AgentConfig(
            id = "special-chars-agent",
            name = "Agent with Special Characters",
            url = "https://test.com/agent",
            systemPrompt = promptWithSpecialChars
        )

        agentRepository.addAgent(testAgent)
        agentRepository.setActiveAgent(testAgent)
        delay(100)

        val activeAgent = agentRepository.activeAgent.value
        assertNotNull(activeAgent)
        assertEquals(promptWithSpecialChars, activeAgent.systemPrompt)
        assertTrue(activeAgent.systemPrompt!!.contains("🤖"))
        assertTrue(activeAgent.systemPrompt!!.contains("ñáéíóú"))
        assertTrue(activeAgent.systemPrompt!!.contains("""{"role": "assistant""""))
    }
}