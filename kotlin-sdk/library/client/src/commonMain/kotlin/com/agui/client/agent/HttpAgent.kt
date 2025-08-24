package com.agui.client.agent

import com.agui.client.sse.SseParser
import com.agui.core.types.*
import io.ktor.client.*
import io.ktor.client.plugins.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.plugins.sse.*
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("HttpAgent")

/**
 * HTTP-based agent implementation using Ktor client.
 * Extends AbstractAgent to provide HTTP/SSE transport.
 */
class HttpAgent(
    private val config: HttpAgentConfig,
    private val httpClient: HttpClient? = null
) : AbstractAgent(config) {
    
    private val client: HttpClient
    private val sseParser = SseParser()
    
    init {
        client = httpClient ?: createPlatformHttpClient(config.requestTimeout, config.connectTimeout)
    }
    
    /**
     * Implementation of abstract run method using HTTP/SSE transport.
     * Makes an HTTP POST request to the configured URL and processes the SSE response stream.
     * 
     * @param input The complete input for the agent run including thread ID, run ID, tools, and context
     * @return Flow<BaseEvent> stream of events received from the agent endpoint
     * @throws CancellationException if the operation is cancelled
     * @throws Exception for network or parsing errors
     */
    override fun run(input: RunAgentInput): Flow<BaseEvent> = channelFlow {
        try {
            client.sse(
                urlString = config.url,
                request = {
                    method = HttpMethod.Post
                    config.headers.forEach { (key, value) ->
                        header(key, value)
                    }
                    contentType(ContentType.Application.Json)
                    accept(ContentType.Text.EventStream)
                    setBody(input)
                }
            ) {
                // Convert SSE events to string flow
                val stringFlow = incoming.mapNotNull { sseEvent ->
                    logger.d { "Raw SSE event: ${sseEvent}" }
                    sseEvent.data?.also { data ->
                        logger.d { "SSE data: $data" }
                    }
                }
                
                // Parse SSE stream
                sseParser.parseFlow(stringFlow)
                    .collect { event ->
                        logger.d { "Parsed event: ${event.eventType}" }
                        send(event)
                    }
            }
        } catch (e: CancellationException) {
            logger.d { "Agent run cancelled" }
            throw e
        } catch (e: Exception) {
            logger.e(e) { "Agent run failed: ${e.message}" }
            
            // Emit error event
            send(RunErrorEvent(
                message = e.message ?: "Unknown error",
                code = when (e) {
                    is HttpRequestTimeoutException -> "TIMEOUT_ERROR"
                    else -> "TRANSPORT_ERROR"
                }
            ))
        }
    }
    
    /**
     * Creates a clone of this agent with the same configuration.
     * The cloned agent will have the same HTTP configuration and current state,
     * but will maintain its own HTTP client lifecycle.
     * 
     * @return AbstractAgent a new HttpAgent instance with identical configuration
     */
    override fun clone(): AbstractAgent {
        return HttpAgent(
            config = HttpAgentConfig(
                agentId = this@HttpAgent.agentId,
                description = this@HttpAgent.description,
                threadId = this@HttpAgent.threadId,
                initialMessages = this@HttpAgent.messages.toList(),
                initialState = this@HttpAgent.state,
                debug = this@HttpAgent.debug,
                url = config.url,
                headers = config.headers,
                requestTimeout = config.requestTimeout,
                connectTimeout = config.connectTimeout
            ),
            httpClient = httpClient
        )
    }
    
    /**
     * Cleanup HTTP client resources only when explicitly closed, not after each run.
     * The HTTP client is designed to be reusable across multiple agent runs,
     * so this method does not close the client.
     */
    override fun onFinalize() {
        super.onFinalize()
        // Don't close the client here - it should be reusable for multiple runs
    }
    
    /**
     * Override dispose to properly cleanup HTTP client resources.
     * Closes the HTTP client if it was created internally (not provided externally).
     * This ensures proper cleanup of network resources and connection pools.
     */
    override fun dispose() {
        // Close the HTTP client if we created it
        if (httpClient == null) {
            client.close()
        }
        super.dispose()
    }
}