package com.agui.example.chatapp.chat

import com.agui.client.agent.AgentSubscriber
import com.agui.client.agent.AgentSubscription
import com.agui.core.types.AssistantMessage
import com.agui.core.types.BaseEvent
import com.agui.core.types.RunErrorEvent
import com.agui.core.types.ToolCallEndEvent
import com.agui.core.types.ToolCallStartEvent
import com.agui.core.types.UserMessage
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
        stub.nextSendFlow = flow { }

        controller.sendMessage("Hi there")
        advanceUntilIdle()

        val pendingSnapshot = controller.state.value.messages.filter { it.role == MessageRole.USER && it.content == "Hi there" }
        assertEquals(1, pendingSnapshot.size)
        assertTrue(pendingSnapshot.isNotEmpty())

        controller.updateMessagesFromAgent(
            listOf(
                UserMessage(id = "user-1", content = "Hi there"),
                AssistantMessage(id = "msg-agent", content = "Hello")
            )
        )

        val messages = controller.state.value.messages
        val userMessages = messages.filter { it.role == MessageRole.USER && it.content == "Hi there" }
        assertEquals(1, userMessages.size)
        assertFalse(userMessages.single().isStreaming)
        val assistant = messages.last { it.role == MessageRole.ASSISTANT }
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
        private val subscribers = mutableListOf<AgentSubscriber>()

        override fun sendMessage(message: String, threadId: String): Flow<BaseEvent>? {
            sentMessages += message to threadId
            return nextSendFlow
        }

        override fun subscribe(subscriber: AgentSubscriber): AgentSubscription {
            subscribers += subscriber
            return object : AgentSubscription {
                override fun unsubscribe() {
                    subscribers.remove(subscriber)
                }
            }
        }
    }
}
