package com.agui.example.chatapp.chat

import com.agui.core.types.BaseEvent
import com.agui.core.types.RunErrorEvent
import com.agui.core.types.TextMessageContentEvent
import com.agui.core.types.TextMessageEndEvent
import com.agui.core.types.TextMessageStartEvent
import com.agui.core.types.ToolCallEndEvent
import com.agui.core.types.ToolCallStartEvent
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.testutil.FakeSettings
import com.agui.example.chatapp.util.UserIdManager
import com.agui.tools.DefaultToolRegistry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerTest {

    @Test
    fun sendMessage_streamingCompletesAndStoresMessages() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        val settings = FakeSettings()
        AgentRepository.resetInstance()
        UserIdManager.resetInstance()

        val factory = StubChatAgentFactory()
        val repository = AgentRepository.getInstance(settings)
        val userIdManager = UserIdManager.getInstance(settings)
        val controller = ChatController(
            externalScope = scope,
            agentFactory = factory,
            settings = settings,
            agentRepository = repository,
            userIdManager = userIdManager
        )
        val agent = AgentConfig(
            id = "agent-1",
            name = "Test Agent",
            url = "https://example.agents.dev",
            authMethod = AuthMethod.None(),
            createdAt = Instant.fromEpochMilliseconds(0)
        )
        repository.addAgent(agent)
        repository.setActiveAgent(agent)
        advanceUntilIdle()

        val stub = factory.createdAgents.single()
        stub.nextSendFlow = flow {
            emit(TextMessageStartEvent(messageId = "msg-agent"))
            emit(TextMessageContentEvent(messageId = "msg-agent", delta = "Hello"))
            emit(TextMessageEndEvent(messageId = "msg-agent"))
        }

        controller.sendMessage("Hi there")
        advanceUntilIdle()

        val messages = controller.state.value.messages
        assertEquals(3, messages.size)
        assertEquals(MessageRole.SYSTEM, messages[0].role)
        assertEquals("Hi there", messages[1].content)
        val assistant = messages[2]
        assertEquals("Hello", assistant.content)
        assertFalse(assistant.isStreaming)

        val recorded = stub.sentMessages.single()
        assertEquals("Hi there", recorded.first)
        assertTrue(recorded.second.isNotBlank())

        controller.close()
        scope.cancel()
        AgentRepository.resetInstance()
    }

    @Test
    fun toolCallEventsManageEphemeralMessages() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        val settings = FakeSettings()
        AgentRepository.resetInstance()
        UserIdManager.resetInstance()

        val repository = AgentRepository.getInstance(settings)
        val userIdManager = UserIdManager.getInstance(settings)
        val controller = ChatController(
            externalScope = scope,
            agentFactory = StubChatAgentFactory(),
            settings = settings,
            agentRepository = repository,
            userIdManager = userIdManager
        )

        controller.handleAgentEvent(ToolCallStartEvent(toolCallId = "call-1", toolCallName = "search"))
        assertTrue(controller.state.value.messages.any { it.role == MessageRole.TOOL_CALL })

        controller.handleAgentEvent(ToolCallEndEvent(toolCallId = "call-1"))
        advanceTimeBy(1000)
        advanceUntilIdle()

        assertFalse(controller.state.value.messages.any { it.role == MessageRole.TOOL_CALL })

        controller.close()
        scope.cancel()
        AgentRepository.resetInstance()
    }

    @Test
    fun runErrorEventAddsErrorMessage() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)
        val settings = FakeSettings()
        AgentRepository.resetInstance()
        UserIdManager.resetInstance()

        val repository = AgentRepository.getInstance(settings)
        val userIdManager = UserIdManager.getInstance(settings)
        val controller = ChatController(
            externalScope = scope,
            agentFactory = StubChatAgentFactory(),
            settings = settings,
            agentRepository = repository,
            userIdManager = userIdManager
        )

        controller.handleAgentEvent(RunErrorEvent(message = "Boom", rawEvent = null, timestamp = null))

        val messages = controller.state.value.messages
        assertEquals(1, messages.size)
        assertEquals(MessageRole.ERROR, messages.first().role)

        controller.close()
        scope.cancel()
        AgentRepository.resetInstance()
    }

    private class StubChatAgentFactory : ChatAgentFactory {
        val createdAgents = mutableListOf<StubChatAgent>()

        override fun createAgent(
            config: AgentConfig,
            headers: Map<String, String>,
            toolRegistry: DefaultToolRegistry,
            userId: String,
            systemPrompt: String?
        ): ChatAgent {
            return StubChatAgent().also { createdAgents += it }
        }
    }

    private class StubChatAgent : ChatAgent {
        var nextSendFlow: Flow<BaseEvent>? = null
        val sentMessages = mutableListOf<Pair<String, String>>()

        override fun sendMessage(message: String, threadId: String): Flow<BaseEvent>? {
            sentMessages += message to threadId
            return nextSendFlow
        }
    }
}
