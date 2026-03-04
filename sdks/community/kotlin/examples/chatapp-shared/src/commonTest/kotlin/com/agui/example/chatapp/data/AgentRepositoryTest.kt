package com.agui.example.chatapp.data

import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.testutil.FakeSettings
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant

class AgentRepositoryTest {
    private lateinit var settings: FakeSettings
    private lateinit var repository: AgentRepository

    @BeforeTest
    fun setUp() {
        AgentRepository.resetInstance()
        settings = FakeSettings()
        repository = AgentRepository.getInstance(settings)
    }

    @AfterTest
    fun tearDown() {
        AgentRepository.resetInstance()
    }

    @Test
    fun addAgent_persistsAgentList() = runTest {
        val agent = AgentConfig(
            id = "agent-1",
            name = "Test Agent",
            url = "https://example.agents.dev",
            authMethod = AuthMethod.None(),
            createdAt = Instant.fromEpochMilliseconds(0)
        )

        repository.addAgent(agent)

        assertEquals(listOf(agent), repository.agents.value)
        assertTrue(settings.hasKey("agents"))
        assertTrue(settings.getStringOrNull("agents")!!.contains("agent-1"))
    }

    @Test
    fun setActiveAgent_updatesStateAndSession() = runTest {
        val agent = AgentConfig(
            id = "agent-42",
            name = "Active Agent",
            url = "https://example.agents.dev",
            authMethod = AuthMethod.None(),
            createdAt = Instant.fromEpochMilliseconds(0)
        )
        repository.addAgent(agent)

        repository.setActiveAgent(agent)

        val active = repository.activeAgent.value
        assertNotNull(active)
        assertEquals(agent.id, active.id)
        assertNotNull(active.lastUsedAt)

        val session = repository.currentSession.value
        assertNotNull(session)
        assertEquals(agent.id, session.agentId)

        assertEquals(agent.id, settings.getStringOrNull("active_agent"))
        assertTrue(settings.getStringOrNull("agents")!!.contains("lastUsedAt"))
    }

    @Test
    fun deleteAgent_removesAgentAndClearsActiveState() = runTest {
        val agent = AgentConfig(
            id = "agent-delete",
            name = "Delete Me",
            url = "https://example.agents.dev",
            authMethod = AuthMethod.None(),
            createdAt = Instant.fromEpochMilliseconds(0)
        )
        repository.addAgent(agent)
        repository.setActiveAgent(agent)

        repository.deleteAgent(agent.id)

        assertTrue(repository.agents.value.isEmpty())
        assertNull(repository.activeAgent.value)
        assertNull(repository.currentSession.value)
        assertFalse(settings.hasKey("active_agent"))
    }
}
