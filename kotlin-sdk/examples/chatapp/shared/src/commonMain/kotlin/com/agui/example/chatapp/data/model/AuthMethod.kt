/*
 * MIT License
 *
 * Copyright (c) 2025 Mark Fogle
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
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