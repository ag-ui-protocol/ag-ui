package com.agui.client.agent

import io.ktor.client.*

/**
 * Platform-specific HttpClient factory
 */
internal expect fun createPlatformHttpClient(
    requestTimeout: Long,
    connectTimeout: Long
): HttpClient