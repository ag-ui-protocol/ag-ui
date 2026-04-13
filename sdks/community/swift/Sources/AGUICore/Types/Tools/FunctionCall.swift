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

/// Represents a function name and its arguments in a tool call.
///
/// `FunctionCall` encapsulates the essential information needed to invoke a function:
/// the function's name and its arguments encoded as a JSON string. This structure
/// provides flexibility in how arguments are structured and validated, deferring
/// parsing and validation to the actual tool execution layer.
///
/// ## Arguments Encoding
///
/// Arguments are stored as a JSON-encoded string rather than a parsed object. This design:
/// - Allows flexibility in argument structures
/// - Defers validation to tool execution time
/// - Supports dynamic function signatures
/// - Maintains compatibility with various serialization formats
///
/// ## Example
///
/// ```swift
/// // Simple function call with basic arguments
/// let weatherCall = FunctionCall(
///     name: "get_weather",
///     arguments: """
///     {
///         "location": "San Francisco",
///         "units": "celsius"
///     }
///     """
/// )
///
/// // Function with no arguments
/// let pingCall = FunctionCall(
///     name: "ping",
///     arguments: "{}"
/// )
///
/// // Parsing arguments at execution time
/// struct WeatherArgs: Codable {
///     let location: String
///     let units: String
/// }
///
/// let argsData = Data(weatherCall.arguments.utf8)
/// let parsedArgs = try JSONDecoder().decode(WeatherArgs.self, from: argsData)
/// ```
///
/// ## Relationship with ToolCall
///
/// `FunctionCall` is typically embedded within a ``ToolCall``, which adds:
/// - A unique identifier for tracking the call
/// - The function type discriminator
///
/// - SeeAlso: ``ToolCall``, ``Tool``
public struct FunctionCall: Sendable, Codable, Hashable {
    /// The name of the function to invoke.
    ///
    /// This should match the name defined in the corresponding ``Tool`` definition.
    /// Function names are typically lowercase with underscores (e.g., "get_weather",
    /// "send_email", "execute_query").
    public let name: String

    /// The function arguments encoded as a JSON string.
    ///
    /// Arguments must be valid JSON. Common patterns:
    /// - Empty arguments: `"{}"`
    /// - Simple arguments: `"{\"location\":\"Paris\"}"`
    /// - Complex arguments: `"{\"filters\":{\"date\":\"2024-01-01\"},\"limit\":100}"`
    ///
    /// The arguments string can be parsed at execution time into a strongly-typed
    /// struct using `JSONDecoder`:
    ///
    /// ```swift
    /// let argsData = Data(functionCall.arguments.utf8)
    /// let parsed = try JSONDecoder().decode(MyArgsType.self, from: argsData)
    /// ```
    public let arguments: String

    /// Creates a new function call.
    ///
    /// - Parameters:
    ///   - name: The name of the function to invoke
    ///   - arguments: The function arguments encoded as a JSON string
    ///
    /// - Note: The arguments parameter should contain valid JSON. Invalid JSON
    ///   will cause errors when the arguments are parsed during execution.
    public init(
        name: String,
        arguments: String
    ) {
        self.name = name
        self.arguments = arguments
    }
}
