package com.agui.client.testing

import com.agui.core.types.AgUiJson
import com.sun.net.httpserver.HttpServer
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.header
import io.ktor.client.plugins.sse.SSE
import io.ktor.serialization.kotlinx.json.json
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * A local HTTP server that answers each request with the next scripted SSE run and records the request bodies.
 * [client] is configured the way an injected client must be: SSE plus ContentNegotiation with [AgUiJson].
 */
internal class ScriptedSseServer(runs: List<List<String>>) : AutoCloseable {
    private val pending = ConcurrentLinkedQueue(runs)
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)

    val requests: MutableList<JsonObject> = CopyOnWriteArrayList()

    /** Requests sent by [client], which marks them with a header. */
    val requestsFromClient: MutableList<JsonObject> = CopyOnWriteArrayList()

    val url: String

    val client = HttpClient(CIO) {
        install(ContentNegotiation) { json(AgUiJson) }
        install(SSE)
        defaultRequest { header(CLIENT_HEADER, "1") }
    }

    init {
        server.createContext("/") { exchange ->
            exchange.use {
                val body = exchange.requestBody.readBytes().decodeToString()
                val request = AgUiJson.parseToJsonElement(body).jsonObject
                requests += request
                if (exchange.requestHeaders.containsKey(CLIENT_HEADER)) requestsFromClient += request
                val events = pending.poll()
                if (events == null) {
                    exchange.sendResponseHeaders(HTTP_GONE, -1)
                    return@use
                }
                val payload = events.joinToString("") { "data: $it\n\n" }.encodeToByteArray()
                exchange.responseHeaders.add("Content-Type", "text/event-stream")
                exchange.sendResponseHeaders(HTTP_OK, payload.size.toLong())
                exchange.responseBody.write(payload)
            }
        }
        server.start()
        url = "http://127.0.0.1:${server.address.port}/agent"
    }

    override fun close() {
        client.close()
        server.stop(0)
    }

    private companion object {
        const val HTTP_OK = 200
        const val HTTP_GONE = 410
        const val CLIENT_HEADER = "X-Scripted-Client"
    }
}
