package com.agui.client

import com.agui.client.testing.ScriptedSseServer
import com.agui.core.types.RunFinishedEvent
import com.agui.core.types.TextMessageContentEvent
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class InjectedHttpClientTest {

    private val answerRun = listOf(
        """{"type":"RUN_STARTED","threadId":"t1","runId":"r1"}""",
        """{"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}""",
        """{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Hello"}""",
        """{"type":"TEXT_MESSAGE_END","messageId":"m1"}""",
        """{"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}"""
    )

    private suspend fun <T> server(runs: List<List<String>>, block: suspend (ScriptedSseServer) -> T): T =
        ScriptedSseServer(runs).use { block(it) }

    @Test
    fun statelessAgentSendsThroughInjectedClient() = runTest {
        val (events, fromClient) = server(listOf(answerRun)) { server ->
            AgUiAgent(server.url) { httpClient = server.client }.sendMessage("Hi", threadId = "t1").toList() to
                server.requestsFromClient.size
        }

        assertEquals(1, fromClient)
        assertEquals("Hello", events.filterIsInstance<TextMessageContentEvent>().single().delta)
        assertTrue(events.last() is RunFinishedEvent)
    }

    @Test
    fun statefulAgentSendsThroughInjectedClient() = runTest {
        val requests = server(listOf(answerRun)) { server ->
            StatefulAgUiAgent(server.url) { httpClient = server.client }.chat("Hi", threadId = "t1").toList()
            server.requestsFromClient
        }

        val messages = requests.single().getValue("messages").jsonArray
        assertEquals("Hi", messages.single().jsonObject["content"]?.jsonPrimitive?.content)
    }

    @Test
    fun closingTheAgentKeepsTheInjectedClientOpen() = runTest {
        val events = server(listOf(answerRun)) { server ->
            AgUiAgent(server.url) { httpClient = server.client }.close()
            AgUiAgent(server.url) { httpClient = server.client }.sendMessage("Hi", threadId = "t1").toList()
        }

        assertTrue(events.last() is RunFinishedEvent)
    }
}
