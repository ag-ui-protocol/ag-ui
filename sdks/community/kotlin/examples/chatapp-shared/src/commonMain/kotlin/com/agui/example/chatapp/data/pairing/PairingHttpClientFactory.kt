package com.agui.example.chatapp.data.pairing

import io.ktor.client.*

/**
 * Factory for creating HTTP clients for pairing requests.
 * This is separate from the AG-UI SDK's HTTP client to allow direct
 * handling of HTTP responses (including 403 status codes with body parsing).
 */
expect fun createPairingHttpClient(): HttpClient
