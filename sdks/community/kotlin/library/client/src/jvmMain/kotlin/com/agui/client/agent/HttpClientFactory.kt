package com.agui.client.agent

import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.plugins.sse.*
import io.ktor.serialization.kotlinx.json.*
import com.agui.core.types.AgUiJson

/**
 * JVM-specific HttpClient factory
 */
internal actual fun createPlatformHttpClient(
    requestTimeout: Long,
    connectTimeout: Long
): HttpClient = HttpClient(CIO) {
    install(ContentNegotiation) {
        json(AgUiJson)
    }
    
    install(SSE)
    
    install(HttpTimeout) {
        requestTimeoutMillis = requestTimeout
        connectTimeoutMillis = connectTimeout
    }
}