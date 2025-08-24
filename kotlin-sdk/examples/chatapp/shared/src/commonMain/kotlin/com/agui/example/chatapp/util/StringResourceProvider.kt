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
package com.agui.example.chatapp.util

import com.agui.example.chatapp.data.model.AuthMethod

/**
 * Provider for accessing string resources outside of Composable functions.
 * This is useful for ViewModels, repositories, and other non-UI classes.
 *
 * Note: This is a simplified approach. In a production app, you might want
 * to use a more sophisticated localization system that can handle plurals,
 * formatting, and other advanced features.
 */
object StringResourceProvider {

    // Connection messages
    fun getConnectedToAgent(agentName: String): String {
        return "Connected to $agentName" // In real app, format with string resource
    }

    fun getFailedToConnect(error: String): String {
        return "Failed to connect: $error" // In real app, format with string resource
    }

    fun getAgentError(error: String): String {
        return "Agent error: $error" // In real app, format with string resource
    }

    fun getErrorPrefix(error: String): String {
        return "Error: $error" // In real app, format with string resource
    }

    // Validation messages
    fun getNameRequired(): String {
        return "Name is required" // In real app, get from string resource
    }

    fun getUrlRequired(): String {
        return "URL is required" // In real app, get from string resource
    }

    fun getUrlInvalid(): String {
        return "URL must start with http:// or https://" // In real app, get from string resource
    }

    // Auth method labels
    fun getAuthMethodLabel(authMethod: AuthMethod): String {
        return when (authMethod) {
            is AuthMethod.None -> "No Authentication"
            is AuthMethod.ApiKey -> "API Key"
            is AuthMethod.BearerToken -> "Bearer Token"
            is AuthMethod.BasicAuth -> "Basic Auth"
            is AuthMethod.OAuth2 -> "OAuth 2.0"
            is AuthMethod.Custom -> "Custom"
        }
    }
}

/**
 * Extension functions to make string resource access easier
 */
object Strings {

    // Common strings that are frequently used in non-Composable contexts
    const val ERROR_PREFIX = "Error: "
    const val AGENT_ERROR_PREFIX = "Agent error: "
    const val FAILED_TO_CONNECT_PREFIX = "Failed to connect: "
    const val CONNECTED_TO_PREFIX = "Connected to "

    // Validation messages
    const val NAME_REQUIRED = "Name is required"
    const val URL_REQUIRED = "URL is required"
    const val URL_INVALID = "URL must start with http:// or https://"
}