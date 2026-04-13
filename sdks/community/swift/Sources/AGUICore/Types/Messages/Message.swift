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

/// Base protocol for all message types in the AG-UI protocol.
///
/// Messages represent communication between different entities in an agent conversation:
/// developers, systems, AI assistants, users, tools, and activities. Each message type
/// is identified by its ``Role``, which serves as the discriminator for polymorphic
/// message deserialization.
///
/// ## Common Properties
///
/// All messages share these properties:
/// - ``id``: Unique identifier for the message instance
/// - ``role``: The sender's role (developer, system, assistant, user, tool, activity)
/// - ``content``: Optional text content of the message
/// - ``name``: Optional identifier for the sender
///
/// ## Message Types
///
/// The protocol is implemented by six concrete message types:
/// - ``DeveloperMessage``: System-level configuration and instructions
/// - ``SystemMessage``: Agent behavioral guidelines and instructions
/// - ``AssistantMessage``: AI agent responses, possibly with tool calls
/// - ``UserMessage``: Human input supporting text and multimodal content
/// - ``ToolMessage``: Results from tool/function executions
/// - ``ActivityMessage``: Streaming structured JSON for custom UI surfaces
///
/// ## Polymorphic Deserialization
///
/// In the AG-UI protocol, messages are serialized with a "role" field that indicates
/// their concrete type. The role field enables protocol implementations to deserialize
/// JSON into the appropriate concrete message type.
///
/// ## Concurrency
///
/// All message types must conform to `Sendable` to safely cross actor isolation
/// boundaries in Swift's structured concurrency model.
///
/// ## Example
///
/// ```swift
/// // Creating different message types
/// let systemMsg = SystemMessage(
///     id: "msg-1",
///     content: "You are a helpful assistant."
/// )
///
/// let userMsg = UserMessage(
///     id: "msg-2",
///     content: "Hello, how can you help me?"
/// )
///
/// // All messages conform to the same protocol
/// let messages: [any Message] = [systemMsg, userMsg]
/// ```
///
/// - SeeAlso: ``Role``
public protocol Message: Sendable {
    /// Unique identifier for this message.
    ///
    /// Message IDs should be unique within a conversation thread to enable
    /// referencing and tracking individual messages.
    var id: String { get }

    /// The role of the message sender.
    ///
    /// This property serves as the discriminator for polymorphic message types,
    /// identifying whether the message comes from a developer, system, assistant,
    /// user, tool, or activity.
    ///
    /// - SeeAlso: ``Role``
    var role: Role { get }

    /// The text content of the message.
    ///
    /// This property is optional because:
    /// - Some message types may convey information through other fields
    /// - SystemMessage content may be optional
    /// - AssistantMessage may contain only tool calls without text
    /// - UserMessage may use multimodal content instead
    var content: String? { get }

    /// Optional identifier for the message sender.
    ///
    /// This can be used to:
    /// - Identify specific users in multi-user conversations
    /// - Label different AI agents in multi-agent systems
    /// - Tag tool invocations with descriptive names
    var name: String? { get }
}
