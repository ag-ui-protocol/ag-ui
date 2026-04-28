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

/// Represents a message from a user in the conversation.
///
/// `UserMessage` supports both simple text messages and multimodal messages
/// containing text, images, audio, documents, and other binary data.
///
/// ## Text-only Messages
///
/// For simple text input, use the standard initializer:
///
/// ```swift
/// let message = UserMessage(
///     id: "user-1",
///     content: "What is the weather like today?"
/// )
/// ```
///
/// ## Multimodal Messages
///
/// For rich input combining text and binary data, use the multimodal factory:
///
/// ```swift
/// let parts: [any InputContent] = [
///     TextInputContent(text: "What's in this image?"),
///     BinaryInputContent(
///         mimeType: "image/jpeg",
///         url: "https://example.com/photo.jpg"
///     )
/// ]
///
/// let message = UserMessage.multimodal(
///     id: "user-2",
///     parts: parts
/// )
/// ```
///
/// ## Serialization
///
/// UserMessage uses custom Codable serialization:
/// - **Text-only**: `content` field is a JSON string
/// - **Multimodal**: `content` field is a JSON array of InputContent objects
///
/// The serialization is transparent and handled automatically during encoding/decoding.
///
/// - SeeAlso: ``Message``, ``InputContent``, ``TextInputContent``, ``BinaryInputContent``
public struct UserMessage: Message, Sendable, Hashable {
    /// The unique identifier for this message.
    public let id: String

    /// The message role (always `.user`).
    public let role: Role

    /// The text content of the message.
    ///
    /// For text-only messages, this contains the user's input.
    /// For multimodal messages, this is empty and content is in `contentParts`.
    public let content: String?

    /// Optional name of the user sending the message.
    public let name: String?

    /// The multimodal content parts.
    ///
    /// This is `nil` for text-only messages and contains the array of
    /// InputContent for multimodal messages.
    public let contentParts: [any InputContent]?

    /// Whether this message contains multimodal content.
    ///
    /// Returns `true` if the message has `contentParts`, `false` for text-only.
    public var isMultimodal: Bool {
        contentParts != nil
    }

    /// Creates a text-only user message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for the message
    ///   - content: The text content
    ///   - name: Optional name of the user
    public init(
        id: String,
        content: String,
        name: String? = nil
    ) {
        self.id = id
        self.role = .user
        self.content = content
        self.name = name
        self.contentParts = nil
    }

    /// Creates a multimodal user message with mixed text and binary content.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for the message
    ///   - parts: Array of InputContent (text and/or binary)
    ///   - name: Optional name of the user
    /// - Returns: A multimodal UserMessage
    public static func multimodal(
        id: String,
        parts: [any InputContent],
        name: String? = nil
    ) -> UserMessage {
        UserMessage(
            id: id,
            role: .user,
            content: "",
            name: name,
            contentParts: parts
        )
    }

    /// Internal initializer for creating multimodal messages.
    private init(
        id: String,
        role: Role,
        content: String,
        name: String?,
        contentParts: [any InputContent]?
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.name = name
        self.contentParts = contentParts
    }

    // MARK: - Hashable

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(role)
        hasher.combine(content)
        hasher.combine(name)
        // Note: contentParts is not directly hashable due to protocol type
        hasher.combine(isMultimodal)
    }

    public static func == (lhs: UserMessage, rhs: UserMessage) -> Bool {
        lhs.id == rhs.id &&
            lhs.role == rhs.role &&
            lhs.content == rhs.content &&
            lhs.name == rhs.name &&
            lhs.isMultimodal == rhs.isMultimodal
    }
}
