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

/// Event for custom, application-specific event types.
///
/// This event type allows applications to define and use custom event types
/// beyond the standard AG-UI protocol events. Each custom event has a unique
/// type identifier and arbitrary JSON data payload.
///
/// Use this event type when:
/// - Implementing application-specific events not covered by the standard protocol
/// - Extending the protocol with custom behavior
/// - Handling domain-specific events (e.g., "com.example.analytics.pageView")
///
/// Custom event type identifiers typically follow reverse-domain notation
/// (e.g., "com.myapp.analytics.pageView", "org.example.userAction.buttonClick")
/// to ensure uniqueness across applications.
///
/// - SeeAlso: `RawEvent`, `UnknownEvent`
public struct CustomEvent: AGUIEvent, Equatable, Sendable {

    // MARK: - Properties

    /// The custom event type identifier.
    ///
    /// This string uniquely identifies the type of custom event. It's recommended
    /// to use reverse-domain notation for globally unique identifiers.
    ///
    /// Examples:
    /// - "com.example.userAction"
    /// - "org.myapp.analytics.pageView"
    /// - "simple.message"
    public let customType: String

    /// The custom event data as raw JSON.
    ///
    /// This contains the event-specific payload in JSON format. The structure
    /// is determined by the custom event type and can be any valid JSON value
    /// (object, array, primitive, or null).
    ///
    /// To access the parsed data, use `parsedData()` or parse the data
    /// using `JSONSerialization.jsonObject(with:)`.
    public let data: Data

    /// Optional timestamp when the event was created.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.custom`).
    public var eventType: EventType { .custom }

    // MARK: - Initialization

    /// Creates a new `CustomEvent`.
    ///
    /// - Parameters:
    ///   - customType: The custom event type identifier (e.g., "com.example.userAction")
    ///   - data: The custom event data as JSON bytes
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        customType: String,
        data: Data,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.customType = customType
        self.data = data
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }

    // MARK: - Convenience Methods

    /// Parses the custom data JSON into a Swift object.
    ///
    /// This method uses `JSONSerialization` because the data structure is
    /// custom and unknown at compile time. It can return any valid JSON value
    /// (object, array, primitive, or null).
    ///
    /// For type-safe parsing when you know the data structure, use
    /// `parsedData(as:)` instead.
    ///
    /// - Returns: The parsed JSON object
    /// - Throws: An error if the data is not valid JSON
    public func parsedData() throws -> Any {
        try JSONSerialization.jsonObject(with: data, options: .allowFragments)
    }

    /// Parses the custom data JSON into a strongly-typed Swift object.
    ///
    /// This method uses `Codable` for type-safe decoding when you know the
    /// expected structure of the custom data. Use this when you have a specific
    /// type that conforms to `Decodable` for your custom event.
    ///
    /// - Parameter type: The type to decode the data as (must conform to `Decodable`)
    /// - Returns: A decoded instance of the specified type
    /// - Throws: A `DecodingError` if the data cannot be decoded as the specified type
    ///
    /// Example:
    /// ```swift
    /// struct UserActionPayload: Decodable {
    ///     let action: String
    ///     let userId: Int
    /// }
    ///
    /// let payload = try event.parsedData(as: UserActionPayload.self)
    /// print("User \(payload.userId) performed: \(payload.action)")
    /// ```
    public func parsedData<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: data)
    }
}

// MARK: - CustomStringConvertible
extension CustomEvent: CustomStringConvertible {
    public var description: String {
        let dataSize = data.count
        let timestampDesc = timestamp?.description ?? "nil"
        return "CustomEvent(customType: \"\(customType)\", data: \(dataSize) bytes, timestamp: \(timestampDesc))"
    }
}

// MARK: - CustomDebugStringConvertible
extension CustomEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        let dataPreview: String
        if let jsonString = String(data: data, encoding: .utf8) {
            let preview = String(jsonString.prefix(100))
            dataPreview = jsonString.count > 100 ? "\(preview)..." : preview
        } else {
            dataPreview = "\(data.count) bytes (invalid UTF-8)"
        }

        return """
        CustomEvent {
            customType: "\(customType)"
            data: \(dataPreview)
            dataSize: \(data.count) bytes
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
