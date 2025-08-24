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
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant

/**
 * Represents a configured agent that the user can connect to.
 */
@Serializable
data class AgentConfig(
    val id: String,
    val name: String,
    val url: String,
    val description: String? = null,
    val authMethod: AuthMethod = AuthMethod.None(),
    val isActive: Boolean = false,
    val createdAt: Instant = Clock.System.now(),
    val lastUsedAt: Instant? = null,
    val customHeaders: Map<String, String> = emptyMap(),
    val systemPrompt: String? = null
) {
    companion object {
        fun generateId(): String {
            val timestamp = Clock.System.now().toEpochMilliseconds()
            val random = kotlin.random.Random.nextInt(1000, 9999)
            return "agent_${timestamp}_${random}"
        }
    }
}

/**
 * Represents the current chat session state.
 */
@Serializable
data class ChatSession(
    val agentId: String,
    val threadId: String,
    val startedAt: Instant = Clock.System.now()
)
