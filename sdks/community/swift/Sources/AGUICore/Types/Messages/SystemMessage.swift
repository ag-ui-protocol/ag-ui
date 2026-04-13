/*
 * MIT License
 *
 * Copyright (c) 2025 Perfect Aduh
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

import Foundation

/// A message containing system instructions and behavioral guidelines for the agent.
///
/// System messages provide high-level instructions, personality traits, behavioral
/// guidelines, and context that shape how the agent responds. These messages are
/// typically established at the conversation's start and remain active throughout
/// the interaction.
///
/// ## Use Cases
///
/// System messages are used for:
/// - Defining agent personality and tone
/// - Setting behavioral guidelines and constraints
/// - Providing domain-specific context
/// - Establishing response format preferences
/// - Configuring safety and ethical boundaries
///
/// ## Example
///
/// ```swift
/// let systemPrompt = SystemMessage(
///     id: "sys-1",
///     content: """
///     You are a professional coding assistant with expertise in Swift.
///     Always:
///     - Explain your reasoning
///     - Write clean, well-documented code
///     - Follow Swift best practices
///     - Be concise but thorough
///     """,
///     name: "SwiftExpert"
/// )
/// ```
///
/// ## Optional Content
///
/// Unlike ``DeveloperMessage``, system messages allow nil content, which can be
/// useful for:
/// - Placeholder system messages to be filled later
/// - System messages that rely only on name for identification
/// - Resetting or clearing system context
///
/// ## Differences from DeveloperMessage
///
/// While both guide agent behavior:
/// - **SystemMessage**: High-level behavioral guidelines, personality, and response patterns
/// - **DeveloperMessage**: System-level technical configuration and meta-instructions
///
/// System messages focus on how the agent should communicate and behave, while
/// developer messages focus on technical constraints and system configuration.
///
/// - SeeAlso: ``Message``, ``DeveloperMessage``
public struct SystemMessage: Message, Sendable, Hashable {
    /// Unique identifier for this message.
    public let id: String

    /// The role of this message (always `.system`).
    public let role: Role

    /// The system's instruction content.
    ///
    /// This typically contains behavioral guidelines, personality traits,
    /// response format preferences, or contextual information. Unlike
    /// ``DeveloperMessage``, this field is optional.
    public let content: String?

    /// Optional identifier for the system or instruction set.
    ///
    /// This can be used to identify different system personas, instruction
    /// sets, or behavioral modes (e.g., "ProfessionalMode", "CasualAssistant").
    public let name: String?

    /// Creates a new system message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for this message
    ///   - content: The system's instruction content (optional)
    ///   - name: Optional identifier for the system or instruction set
    public init(
        id: String,
        content: String? = nil,
        name: String? = nil
    ) {
        self.id = id
        self.role = .system
        self.content = content
        self.name = name
    }
}
