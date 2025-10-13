package com.agui.client.tools

import com.agui.client.agent.HttpAgent
import com.agui.client.agent.RunAgentParameters
import com.agui.core.types.*
import com.agui.tools.ToolResponseHandler
import kotlinx.coroutines.flow.collect
import kotlinx.datetime.Clock
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("ClientToolResponseHandler")

/**
 * Tool response handler that sends responses back through the HTTP agent
 *
 * @param httpAgent The HTTP agent to send tool responses through
 */
class ClientToolResponseHandler(
    private val httpAgent: HttpAgent
) : ToolResponseHandler {

    /**
     * Send a tool response back to the agent
     *
     * @param toolMessage The tool message containing the response
     * @param threadId The thread ID for the conversation
     * @param runId The run ID for the current execution
     */
    override suspend fun sendToolResponse(
        toolMessage: ToolMessage,
        threadId: String?,
        runId: String?
    ) {
        logger.i { "Sending tool response for thread: $threadId, run: $runId" }

        // Create a minimal input with just the tool message
        val input = RunAgentInput(
            threadId = threadId ?: "tool_thread_${Clock.System.now().toEpochMilliseconds()}",
            runId = runId ?: "tool_run_${Clock.System.now().toEpochMilliseconds()}",
            messages = listOf(toolMessage)
        )

        // Send through HTTP agent
        try {
            httpAgent.runAgent(RunAgentParameters(
                runId = input.runId,
                tools = input.tools,
                context = input.context,
                forwardedProps = input.forwardedProps
            ))
            logger.d { "Tool response sent successfully" }
        } catch (e: Exception) {
            logger.e(e) { "Failed to send tool response" }
            throw e
        }
    }
}