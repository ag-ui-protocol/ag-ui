package com.agui.example.chatapp.data.auth

import com.agui.example.chatapp.data.model.AuthMethod
import okio.ByteString.Companion.encodeUtf8

class BasicAuthProvider : AuthProvider {
    override fun canHandle(authMethod: AuthMethod): Boolean {
        return authMethod is AuthMethod.BasicAuth
    }

    override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
        when (authMethod) {
            is AuthMethod.BasicAuth -> {
                val credentials = "${authMethod.username}:${authMethod.password}"
                val encoded = credentials.encodeUtf8().base64()
                headers["Authorization"] = "Basic $encoded"
            }
            else -> throw IllegalArgumentException("Unsupported auth method")
        }
    }

    override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod {
        return authMethod
    }

    override suspend fun isAuthValid(authMethod: AuthMethod): Boolean {
        return authMethod is AuthMethod.BasicAuth &&
                authMethod.username.isNotBlank() &&
                authMethod.password.isNotBlank()
    }
}