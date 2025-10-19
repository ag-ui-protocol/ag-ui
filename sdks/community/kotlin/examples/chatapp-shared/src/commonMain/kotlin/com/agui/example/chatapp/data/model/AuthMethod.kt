package com.agui.example.chatapp.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName

/**
 * Represents different authentication methods supported by agents.
 */
@Serializable
sealed class AuthMethod {
    @Serializable
    @SerialName("none")
    data class None(val id: String = "none") : AuthMethod()

    @Serializable
    @SerialName("api_key")
    data class ApiKey(
        val key: String,
        val headerName: String = "X-API-Key"
    ) : AuthMethod()

    @Serializable
    @SerialName("bearer_token")
    data class BearerToken(
        val token: String
    ) : AuthMethod()

    @Serializable
    @SerialName("basic_auth")
    data class BasicAuth(
        val username: String,
        val password: String
    ) : AuthMethod()

    @Serializable
    @SerialName("oauth2")
    data class OAuth2(
        val clientId: String,
        val clientSecret: String? = null,
        val authorizationUrl: String,
        val tokenUrl: String,
        val scopes: List<String> = emptyList(),
        val accessToken: String? = null,
        val refreshToken: String? = null
    ) : AuthMethod()

    @Serializable
    @SerialName("custom")
    data class Custom(
        val type: String,
        val config: Map<String, String>
    ) : AuthMethod()
}