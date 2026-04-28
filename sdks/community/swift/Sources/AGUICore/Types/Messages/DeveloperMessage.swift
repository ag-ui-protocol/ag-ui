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

/// A message containing system-level instructions and configuration.
///
/// Developer messages provide system-level instructions, configuration, and
/// administrative communication that differs from regular system prompts. They
/// typically contain meta-instructions about how the agent should behave or
/// technical configuration details.
///
/// ## Use Cases
///
/// Developer messages are used for:
/// - System configuration and initialization
/// - Meta-instructions about agent behavior
/// - Technical constraints and requirements
/// - Administrative control messages
/// - Debug and logging configuration
///
/// ## Example
///
/// ```swift
/// let configMessage = DeveloperMessage(
///     id: "dev-config-1",
///     content: """
///     System configuration:
///     - Enable debug logging
///     - Set max response length to 2000 tokens
///     - Use conservative safety settings
///     """,
///     name: "SystemConfigurator"
/// )
/// ```
///
/// ## Differences from SystemMessage
///
/// While both developer and system messages guide agent behavior:
/// - **DeveloperMessage**: System-level technical configuration and meta-instructions
/// - **SystemMessage**: High-level behavioral guidelines and personality instructions
///
/// Developer messages typically contain more technical, configuration-oriented
/// content, while system messages focus on behavioral patterns and response style.
///
/// - SeeAlso: ``Message``, ``SystemMessage``
public struct DeveloperMessage: Message, Sendable, Hashable {
    /// Unique identifier for this message.
    public let id: String

    /// The role of this message (always `.developer`).
    public let role: Role

    /// The developer's message content.
    ///
    /// This typically contains system-level instructions, configuration details,
    /// or meta-instructions about agent behavior.
    ///
    /// While the protocol allows optional content, developer messages in practice
    /// always contain content, so the initializer requires a non-nil value.
    public let content: String?

    /// Optional identifier for the developer or system.
    ///
    /// This can be used to identify which developer, system component, or
    /// configuration module generated the message.
    public let name: String?

    /// Creates a new developer message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for this message
    ///   - content: The developer's message content
    ///   - name: Optional identifier for the developer or system
    public init(
        id: String,
        content: String,
        name: String? = nil
    ) {
        self.id = id
        self.role = .developer
        self.content = content
        self.name = name
    }
}
