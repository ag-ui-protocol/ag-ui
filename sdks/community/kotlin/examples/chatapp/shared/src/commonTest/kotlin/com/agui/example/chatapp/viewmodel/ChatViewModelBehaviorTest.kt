package com.agui.example.chatapp.viewmodel

import com.agui.client.agent.AgentSubscriber
import com.agui.client.agent.AgentSubscription
import com.agui.core.types.BaseEvent
import com.agui.example.chatapp.chat.ChatAgent
import com.agui.example.chatapp.chat.ChatAgentFactory
import com.agui.example.chatapp.chat.ChatController
import com.agui.example.chatapp.chat.MessageRole
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.test.TestSettings
import com.agui.example.chatapp.ui.screens.chat.ChatViewModel
import com.agui.example.chatapp.util.UserIdManager
import com.agui.tools.DefaultToolRegistry
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant

@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelBehaviorTest {
    private lateinit var settings: TestSettings

    @BeforeTest
    fun setUp() {
        settings = TestSettings()
        AgentRepository.resetInstance()
        UserIdManager.resetInstance()
    }

    @AfterTest
    fun tearDown() {
        AgentRepository.resetInstance()
        UserIdManager.resetInstance()
    }

    @Test
    fun stateReflectsActiveAgentChanges() = runTest {
        val repository = AgentRepository.getInstance(settings)
        val userIdManager = UserIdManager.getInstance(settings)
        val agentFactory = StubChatAgentFactory()
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)

        val viewModel = ChatViewModel(
            scopeFactory = { scope },
            controllerFactory = { externalScope ->
                ChatController(
                    externalScope = externalScope,
                    agentFactory = agentFactory,
                    settings = settings,
                    agentRepository = repository,
                    userIdManager = userIdManager
                )
            }
        )

        val agent = AgentConfig(
            id = "agent-1",
            name = "Primary Agent",
            url = "https://example.agents.dev",
            authMethod = AuthMethod.None(),
            createdAt = Instant.fromEpochMilliseconds(0)
        )

        repository.addAgent(agent)
        repository.setActiveAgent(agent)
        advanceUntilIdle()

        val state = viewModel.state.value
        assertEquals(agent.id, state.activeAgent?.id)
        assertTrue(state.isConnected)
        assertTrue(state.messages.any { it.role == MessageRole.SYSTEM })

        viewModel.dispose()
    }

    @Test
    fun sendMessageDelegatesToControllerAndTracksStreaming() = runTest {
        val repository = AgentRepository.getInstance(settings)
        val userIdManager = UserIdManager.getInstance(settings)
        val agentFactory = StubChatAgentFactory()
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)

        val viewModel = ChatViewModel(
            scopeFactory = { scope },
            controllerFactory = { externalScope ->
                ChatController(
                    externalScope = externalScope,
                    agentFactory = agentFactory,
                    settings = settings,
                    agentRepository = repository,
                    userIdManager = userIdManager
                )
            }
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

        val stubAgent = agentFactory.createdAgents.single()

        viewModel.sendMessage("Hi there")
        advanceUntilIdle()

        val recorded = stubAgent.sentMessages.single()
        assertEquals("Hi there", recorded.first)
        assertTrue(recorded.second.isNotBlank())

        assertFalse(viewModel.state.value.isLoading)

        viewModel.dispose()
    }

    @Test
    fun cancelAndDisposeStopActiveWork() = runTest {
        val repository = AgentRepository.getInstance(settings)
        val userIdManager = UserIdManager.getInstance(settings)
        val agentFactory = StubChatAgentFactory()
        val dispatcher = StandardTestDispatcher(testScheduler)
        val scope = TestScope(dispatcher)

        val viewModel = ChatViewModel(
            scopeFactory = { scope },
            controllerFactory = { externalScope ->
                ChatController(
                    externalScope = externalScope,
                    agentFactory = agentFactory,
                    settings = settings,
                    agentRepository = repository,
                    userIdManager = userIdManager
                )
            }
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

        val stubAgent = agentFactory.createdAgents.single()
        stubAgent.nextSendFlow = flow { awaitCancellation() }

        viewModel.sendMessage("Processing")
        advanceUntilIdle()

        assertTrue(viewModel.state.value.isLoading)

        viewModel.cancelCurrentOperation()
        advanceUntilIdle()

        assertFalse(viewModel.state.value.isLoading)

        viewModel.dispose()
        advanceUntilIdle()
        val finalState = viewModel.state.value
        assertFalse(finalState.isConnected)
        assertTrue(finalState.messages.isEmpty())
    }

    private class StubChatAgentFactory : ChatAgentFactory {
        val createdAgents = mutableListOf<StubChatAgent>()

        override fun createAgent(
            config: AgentConfig,
            headers: Map<String, String>,
            toolRegistry: DefaultToolRegistry,
            userId: String,
            systemPrompt: String?
        ): ChatAgent = StubChatAgent().also { createdAgents += it }
    }

    private class StubChatAgent : ChatAgent {
        val sentMessages = mutableListOf<Pair<String, String>>()
        var nextSendFlow: Flow<BaseEvent>? = null

        override fun sendMessage(message: String, threadId: String): Flow<BaseEvent>? {
            sentMessages += message to threadId
            return nextSendFlow ?: emptyFlow()
        }

        override fun subscribe(subscriber: AgentSubscriber): AgentSubscription {
            return object : AgentSubscription {
                override fun unsubscribe() = Unit
            }
        }
    }
}
