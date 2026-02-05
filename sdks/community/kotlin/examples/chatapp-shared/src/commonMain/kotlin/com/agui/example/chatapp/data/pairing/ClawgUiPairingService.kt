package com.agui.example.chatapp.data.pairing

import co.touchlab.kermit.Logger
import com.agui.example.chatapp.data.model.ClawgUiPairingResponse
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.serialization.json.Json

private val logger = Logger.withTag("ClawgUiPairingService")

/**
 * Service for handling clawg-ui pairing protocol.
 *
 * The clawg-ui pairing flow:
 * 1. Client sends POST to /v1/clawg-ui WITHOUT auth header
 * 2. Server responds with HTTP 403 containing pairing info
 * 3. User shares pairing code with gateway owner
 * 4. Gateway owner approves: `openclaw pairing approve clawg-ui <code>`
 * 5. Bearer token becomes valid for authenticated requests
 */
class ClawgUiPairingService(
    private val httpClientProvider: () -> HttpClient
) {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    /**
     * Initiates the pairing process by making a probe request to the clawg-ui endpoint.
     *
     * @param url The clawg-ui endpoint URL (must contain /v1/clawg-ui)
     * @return Result containing pairing response on success, or error on failure
     */
    suspend fun initiatePairing(url: String): Result<ClawgUiPairingResponse> {
        return try {
            logger.d { "Initiating clawg-ui pairing for URL: $url" }
            val client = httpClientProvider()
            val response: HttpResponse = client.post(url) {
                contentType(ContentType.Application.Json)
                setBody("{}")
            }

            when (response.status) {
                HttpStatusCode.Forbidden -> {
                    val body = response.bodyAsText()
                    logger.d { "Received 403 pairing response: $body" }
                    val pairingResponse = json.decodeFromString<ClawgUiPairingResponse>(body)
                    Result.success(pairingResponse)
                }
                HttpStatusCode.OK -> {
                    Result.failure(AlreadyPairedException("Token is already approved"))
                }
                else -> {
                    Result.failure(PairingException(
                        "Unexpected response: ${response.status.value} ${response.status.description}"
                    ))
                }
            }
        } catch (e: Exception) {
            logger.e(e) { "Failed to initiate pairing" }
            Result.failure(PairingException("Failed to initiate pairing: ${e.message}", e))
        }
    }

    /**
     * Tests if a bearer token is now approved by making an authenticated request.
     *
     * @param url The clawg-ui endpoint URL
     * @param bearerToken The token to test
     * @return Result with true if token is approved, false if still pending (403)
     */
    suspend fun isTokenApproved(url: String, bearerToken: String): Result<Boolean> {
        return try {
            logger.d { "Checking if token is approved for URL: $url" }
            val client = httpClientProvider()
            val response: HttpResponse = client.post(url) {
                contentType(ContentType.Application.Json)
                header("Authorization", "Bearer $bearerToken")
                setBody("{}")
            }

            when (response.status) {
                HttpStatusCode.OK -> {
                    logger.d { "Token is approved" }
                    Result.success(true)
                }
                HttpStatusCode.Forbidden -> {
                    logger.d { "Token not yet approved (still 403)" }
                    Result.success(false)
                }
                else -> Result.failure(PairingException(
                    "Unexpected response: ${response.status.value}"
                ))
            }
        } catch (e: Exception) {
            logger.e(e) { "Failed to check token approval" }
            Result.failure(PairingException("Failed to check token approval: ${e.message}", e))
        }
    }

    companion object {
        private val CLAWG_UI_PATTERN = Regex(".*/v1/clawg-ui.*")

        /**
         * Checks if a URL is a clawg-ui endpoint.
         */
        fun isClawgUiEndpoint(url: String): Boolean {
            return CLAWG_UI_PATTERN.matches(url)
        }
    }
}

class PairingException(message: String, cause: Throwable? = null) : Exception(message, cause)
class AlreadyPairedException(message: String) : Exception(message)
