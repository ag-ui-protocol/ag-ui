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

/// Represents a text fragment in multimodal user input.
///
/// `TextInputContent` is the simplest form of user input content, containing
/// plain text. It is used alongside ``BinaryInputContent`` to build multimodal
/// messages that combine text and binary data.
///
/// ## Usage
///
/// Text content can be used in two ways:
///
/// 1. **Simple text messages** (via UserMessage string content)
/// 2. **Multimodal messages** (via UserMessage content array)
///
/// ```swift
/// // Standalone text content
/// let textContent = TextInputContent(
///     text: "What is the capital of France?"
/// )
///
/// // Mixed with binary content in multimodal message
/// let contents: [any InputContent] = [
///     TextInputContent(text: "Analyze this image:"),
///     BinaryInputContent(
///         mimeType: "image/jpeg",
///         url: "https://example.com/photo.jpg"
///     ),
///     TextInputContent(text: "What objects do you see?")
/// ]
/// ```
///
/// ## Text Content Characteristics
///
/// - **Simple**: Contains only text, no formatting or metadata
/// - **Flexible**: Supports any string content including Unicode, code, markdown
/// - **Composable**: Can be interleaved with binary content in multimodal messages
///
/// ## Type Discrimination
///
/// The `type` field is always `"text"`, enabling polymorphic deserialization
/// when InputContent arrays are decoded from JSON.
///
/// - SeeAlso: ``InputContent``, ``BinaryInputContent``, ``UserMessage``
public struct TextInputContent: InputContent {
    /// The content type discriminator (always "text").
    public let type: String

    /// The text content.
    ///
    /// This can contain:
    /// - Simple questions or statements
    /// - Multi-line text with formatting
    /// - Code snippets
    /// - Markdown
    /// - Unicode characters and emoji
    public let text: String

    /// Creates a new text content instance.
    ///
    /// - Parameter text: The text content
    public init(text: String) {
        self.type = "text"
        self.text = text
    }
}
