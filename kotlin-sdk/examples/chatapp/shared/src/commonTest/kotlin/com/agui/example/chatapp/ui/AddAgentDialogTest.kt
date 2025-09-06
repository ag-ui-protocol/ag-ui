package com.agui.example.chatapp.ui

import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import kotlin.test.*

/**
 * Tests for system prompt functionality in AddAgentDialog.
 * These are unit tests for the dialog logic, not UI rendering tests.
 */
class AddAgentDialogTest {

    @Test
    fun testAgentCreationWithSystemPrompt() {
        // Simulate creating a new agent with system prompt
        val systemPrompt = "You are a helpful AI assistant specialized in software development."
        
        val agent = AgentConfig(
            id = AgentConfig.generateId(),
            name = "Dev Assistant",
            url = "https://api.example.com/agent",
            description = "A development assistant",
            authMethod = AuthMethod.ApiKey("secret", "X-API-Key"),
            systemPrompt = systemPrompt
        )

        assertEquals("Dev Assistant", agent.name)
        assertEquals("https://api.example.com/agent", agent.url)
        assertEquals("A development assistant", agent.description)
        assertEquals(systemPrompt, agent.systemPrompt)
        assertTrue(agent.authMethod is AuthMethod.ApiKey)
    }

    @Test
    fun testAgentCreationWithoutSystemPrompt() {
        // Simulate creating a new agent without system prompt
        val agent = AgentConfig(
            id = AgentConfig.generateId(),
            name = "Basic Agent",
            url = "https://api.example.com/basic",
            systemPrompt = null
        )

        assertEquals("Basic Agent", agent.name)
        assertEquals("https://api.example.com/basic", agent.url)
        assertNull(agent.systemPrompt)
    }

    @Test
    fun testAgentEditingPreservesSystemPrompt() {
        // Simulate editing an existing agent
        val originalAgent = AgentConfig(
            id = "existing-agent",
            name = "Original Agent",
            url = "https://api.example.com/original",
            systemPrompt = "Original system prompt"
        )

        // Simulate editing the agent (keeping system prompt)
        val editedAgent = originalAgent.copy(
            name = "Updated Agent",
            url = "https://api.example.com/updated",
            systemPrompt = "Updated system prompt with new instructions"
        )

        assertEquals("existing-agent", editedAgent.id) // ID should remain the same
        assertEquals("Updated Agent", editedAgent.name)
        assertEquals("https://api.example.com/updated", editedAgent.url)
        assertEquals("Updated system prompt with new instructions", editedAgent.systemPrompt)
    }

    @Test
    fun testAgentSystemPromptRemoval() {
        // Simulate removing system prompt from existing agent
        val agentWithPrompt = AgentConfig(
            id = "agent-with-prompt",
            name = "Agent with Prompt",
            url = "https://api.example.com/agent",
            systemPrompt = "This prompt will be removed"
        )

        val agentWithoutPrompt = agentWithPrompt.copy(systemPrompt = null)

        assertEquals("agent-with-prompt", agentWithoutPrompt.id)
        assertEquals("Agent with Prompt", agentWithoutPrompt.name)
        assertNull(agentWithoutPrompt.systemPrompt)
    }

    @Test
    fun testSystemPromptTrimming() {
        // Test that empty/whitespace-only system prompts are treated as null
        val systemPromptWithWhitespace = "   \n\t   "
        val trimmedPrompt = systemPromptWithWhitespace.trim().takeIf { it.isNotEmpty() }
        
        assertNull(trimmedPrompt, "Whitespace-only system prompt should be treated as null")

        // Test valid prompt with surrounding whitespace
        val validPromptWithWhitespace = "  You are a helpful assistant.  \n\t"
        val trimmedValidPrompt = validPromptWithWhitespace.trim().takeIf { it.isNotEmpty() }
        
        assertEquals("You are a helpful assistant.", trimmedValidPrompt)
    }

    @Test
    fun testSystemPromptWithMultipleLines() {
        val multilinePrompt = """
            You are an AI assistant with the following guidelines:
            
            1. Be helpful and informative
            2. Provide accurate information
            3. Ask for clarification when needed
            
            Always maintain a professional tone.
        """.trimIndent()

        val agent = AgentConfig(
            id = "multiline-agent",
            name = "Multiline Prompt Agent",
            url = "https://api.example.com/multiline",
            systemPrompt = multilinePrompt
        )

        assertEquals(multilinePrompt, agent.systemPrompt)
        assertTrue(agent.systemPrompt!!.contains("AI assistant"))
        assertTrue(agent.systemPrompt!!.contains("professional tone"))
        assertTrue(agent.systemPrompt!!.contains("1. Be helpful"))
    }

    @Test
    fun testSystemPromptValidationLogic() {
        // Test the validation logic that would be used in the dialog
        
        // Valid cases
        assertTrue(isValidSystemPrompt("You are a helpful assistant"))
        assertTrue(isValidSystemPrompt("Multi\nline\nprompt"))
        assertTrue(isValidSystemPrompt("Prompt with special chars: @#$%^&*()"))
        
        // Invalid cases (null or empty after trimming)
        assertFalse(isValidSystemPrompt(null))
        assertFalse(isValidSystemPrompt(""))
        assertFalse(isValidSystemPrompt("   "))
        assertFalse(isValidSystemPrompt("\n\t  \n"))
    }

    @Test
    fun testSystemPromptMaxLength() {
        // Test handling of very long system prompts
        val longPrompt = "A".repeat(5000) // Very long prompt
        
        val agent = AgentConfig(
            id = "long-prompt-agent",
            name = "Long Prompt Agent",
            url = "https://api.example.com/long",
            systemPrompt = longPrompt
        )

        assertEquals(longPrompt, agent.systemPrompt)
        assertEquals(5000, agent.systemPrompt!!.length)
    }

    @Test
    fun testSystemPromptWithUnicodeCharacters() {
        val unicodePrompt = "You are an AI assistant 🤖. Respond with emojis when appropriate 😊. Support múltiple languages: español, français, 中文."
        
        val agent = AgentConfig(
            id = "unicode-agent",
            name = "Unicode Agent",
            url = "https://api.example.com/unicode",
            systemPrompt = unicodePrompt
        )

        assertEquals(unicodePrompt, agent.systemPrompt)
        assertTrue(agent.systemPrompt!!.contains("🤖"))
        assertTrue(agent.systemPrompt!!.contains("español"))
        assertTrue(agent.systemPrompt!!.contains("中文"))
    }

    private fun isValidSystemPrompt(prompt: String?): Boolean {
        return prompt?.trim()?.isNotEmpty() == true
    }
}