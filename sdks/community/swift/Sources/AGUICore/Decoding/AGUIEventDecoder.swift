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

/// Decoder for AG-UI protocol events with polymorphic deserialization.
///
/// `AGUIEventDecoder` decodes JSON event data into strongly-typed event objects based on
/// the "type" field in the JSON. It uses a registry-based architecture that allows you to
/// customize which event types are supported and how unknown events are handled.
///
/// ## Basic Usage
///
/// ```swift
/// // Create a decoder with default settings (strict mode)
/// let decoder = AGUIEventDecoder()
///
/// // Decode an event from JSON data
/// let event = try decoder.decode(jsonData)
///
/// // Pattern match on the event type
/// switch event.eventType {
/// case .runStarted:
///     let runStarted = event as! RunStartedEvent
///     print("Run started: \(runStarted.runId)")
/// case .runFinished:
///     let runFinished = event as! RunFinishedEvent
///     print("Run finished: \(runFinished.runId)")
/// default:
///     print("Other event: \(event.eventType)")
/// }
/// ```
///
/// ## Configuration Modes
///
/// ### Strict Mode (Default)
///
/// In strict mode, unknown or unsupported events throw errors:
///
/// ```swift
/// let decoder = AGUIEventDecoder() // Default: .throwError
/// // Throws EventDecodingError.unknownEventType for unrecognized types
/// ```
///
/// ### Tolerant Mode
///
/// In tolerant mode, unknown events are returned as `UnknownEvent`:
///
/// ```swift
/// var config = AGUIEventDecoder.Configuration()
/// config.unknownEventStrategy = .returnUnknown
/// let decoder = AGUIEventDecoder(config: config)
///
/// let event = try decoder.decode(data)
/// if let unknown = event as? UnknownEvent {
///     print("Unknown event type: \(unknown.typeRaw)")
///     // Can still access raw JSON for forwarding or logging
/// }
/// ```
///
/// ## Custom Registries
///
/// You can provide a custom registry to control which event types are supported:
///
/// ```swift
/// let customRegistry: [EventType: AGUIEventDecoder.DecodeHandler] = [
///     .runStarted: { data, decoder in
///         try decoder.decode(RunStartedEventDTO.self, from: data).toDomain(rawEvent: data)
///     }
///     // Add more handlers as needed
/// ]
///
/// let decoder = AGUIEventDecoder(registry: customRegistry)
/// ```
///
/// ## Error Handling
///
/// The decoder throws `EventDecodingError` for various failure scenarios:
///
/// - `.missingTypeField`: The JSON is missing the required "type" field
/// - `.invalidJSON`: The JSON data is malformed or invalid
/// - `.unknownEventType(String)`: The event type is not recognized (strict mode only)
/// - `.unsupportedEventType(EventType)`: The event type is known but has no handler (strict mode only)
/// - `.decodingFailed(String)`: Field-level decoding errors with detailed messages
///
/// ## Thread Safety
///
/// `AGUIEventDecoder` is thread-safe and can be used concurrently. The decoder itself
/// is immutable after initialization, and all configuration is `Sendable`.
///
/// - SeeAlso: `AGUIEvent`, `EventType`, `EventDecodingError`, `UnknownEvent`
public struct AGUIEventDecoder {

    /// Handler function type for decoding a specific event type.
    ///
    /// Each handler receives the raw JSON data and a `JSONDecoder`, and returns
    /// a decoded `AGUIEvent` instance. Handlers are responsible for:
    ///
    /// 1. Decoding the event-specific DTO from the JSON data
    /// 2. Converting the DTO to the domain event type
    /// 3. Preserving the raw event data for debugging/forwarding
    ///
    /// - Parameters:
    ///   - data: The raw JSON data for the event
    ///   - decoder: A `JSONDecoder` instance for decoding
    /// - Returns: A decoded `AGUIEvent` instance
    /// - Throws: `EventDecodingError` or `DecodingError` if decoding fails
    public typealias DecodeHandler = @Sendable (_ data: Data, _ decoder: JSONDecoder) throws -> any AGUIEvent

    /// Configuration options for the decoder.
    ///
    /// Use `Configuration` to customize decoder behavior, particularly how unknown
    /// or unsupported events are handled.
    ///
    /// ```swift
    /// var config = AGUIEventDecoder.Configuration()
    /// config.unknownEventStrategy = .returnUnknown
    /// let decoder = AGUIEventDecoder(config: config)
    /// ```
    public struct Configuration: Sendable {
        /// Strategy for handling unknown or unsupported event types.
        ///
        /// Defaults to `.throwError` (strict mode).
        public var unknownEventStrategy: UnknownEventStrategy = .throwError

        /// Creates a new configuration with default settings.
        public init() {}
    }

    /// Strategy for handling unknown or unsupported event types.
    ///
    /// - `.throwError`: Throw `EventDecodingError` when encountering unknown/unsupported events (strict mode)
    /// - `.returnUnknown`: Return `UnknownEvent` instances for unknown/unsupported events (tolerant mode)
    ///
    /// Tolerant mode is useful for:
    /// - Forward compatibility with future protocol extensions
    /// - Graceful degradation when some event types aren't implemented
    /// - Logging or forwarding events you don't understand yet
    public enum UnknownEventStrategy: Sendable {
        /// Throw an error when encountering unknown or unsupported events.
        ///
        /// This is the default behavior and ensures type safety by requiring
        /// all events to be properly decoded.
        case throwError

        /// Return `UnknownEvent` instances for unknown or unsupported events.
        ///
        /// Enables forward compatibility and graceful handling of events
        /// that aren't yet implemented or recognized.
        case returnUnknown
    }

    private let config: Configuration
    private let makeDecoder: @Sendable () -> JSONDecoder
    private let registry: [EventType: DecodeHandler]

    // MARK: - Initialization

    /// Creates a new `AGUIEventDecoder`.
    ///
    /// - Parameters:
    ///   - config: Configuration options for the decoder (defaults to strict mode)
    ///   - makeDecoder: Factory function for creating `JSONDecoder` instances (defaults to standard `JSONDecoder()`)
    ///   - registry: Dictionary mapping event types to their decode handlers (defaults to `defaultRegistry()`)
    ///
    /// The decoder uses the provided registry to determine which event types can be decoded.
    /// If no registry is provided, it uses `defaultRegistry()` which includes all lifecycle events.
    ///
    /// Example with custom JSON decoder:
    /// ```swift
    /// let decoder = AGUIEventDecoder(
    ///     makeDecoder: {
    ///         let jsonDecoder = JSONDecoder()
    ///         jsonDecoder.dateDecodingStrategy = .millisecondsSince1970
    ///         return jsonDecoder
    ///     }
    /// )
    /// ```
    public init(
        config: Configuration = .init(),
        makeDecoder: @escaping @Sendable () -> JSONDecoder = { JSONDecoder() },
        registry: [EventType: DecodeHandler] = AGUIEventDecoder.defaultRegistry()
    ) {
        self.config = config
        self.makeDecoder = makeDecoder
        self.registry = registry
    }

    // MARK: - Decoding

    /// Decodes JSON data into an `AGUIEvent` instance.
    ///
    /// The decoder performs polymorphic deserialization by:
    /// 1. Extracting the "type" field from the JSON
    /// 2. Looking up the appropriate decode handler in the registry
    /// 3. Invoking the handler to decode the event-specific data
    ///
    /// - Parameter data: The JSON data to decode
    /// - Returns: A decoded `AGUIEvent` instance (specific type depends on the "type" field)
    /// - Throws: `EventDecodingError` if decoding fails or the event type is unknown/unsupported (in strict mode)
    ///
    /// Example:
    /// ```swift
    /// let jsonData = """
    /// {
    ///   "type": "RUN_STARTED",
    ///   "threadId": "thread-123",
    ///   "runId": "run-456"
    /// }
    /// """.data(using: .utf8)!
    ///
    /// let decoder = AGUIEventDecoder()
    /// let event = try decoder.decode(jsonData)
    ///
    /// if let runStarted = event as? RunStartedEvent {
    ///     print("Run \(runStarted.runId) started in thread \(runStarted.threadId)")
    /// }
    /// ```
    public func decode(_ data: Data) throws -> any AGUIEvent {
        let decoder = makeDecoder()

        let disc = try decodeTypeDiscriminator(from: data, decoder: decoder)

        guard let type = EventType(rawValue: disc.typeRaw) else {
            return try handleUnknownEventType(typeRaw: disc.typeRaw, rawEvent: data)
        }

        guard let handler = registry[type] else {
            return try handleMissingHandler(for: type, typeRaw: disc.typeRaw, rawEvent: data)
        }

        return try executeHandler(handler, data: data, decoder: decoder)
    }

    private func decodeTypeDiscriminator(from data: Data, decoder: JSONDecoder) throws -> TypeDiscriminator {
        do {
            return try decoder.decode(TypeDiscriminator.self, from: data)
        } catch let error as DecodingError {
            throw mapDecodingError(error)
        } catch {
            throw EventDecodingError.invalidJSON
        }
    }

    private func handleUnknownEventType(typeRaw: String, rawEvent: Data) throws -> any AGUIEvent {
        switch config.unknownEventStrategy {
        case .throwError:
            throw EventDecodingError.unknownEventType(typeRaw)
        case .returnUnknown:
            return UnknownEvent(typeRaw: typeRaw, rawEvent: rawEvent)
        }
    }

    private func handleMissingHandler(
        for type: EventType,
        typeRaw: String,
        rawEvent: Data
    ) throws -> any AGUIEvent {
        switch config.unknownEventStrategy {
        case .throwError:
            throw EventDecodingError.unsupportedEventType(type)
        case .returnUnknown:
            return UnknownEvent(typeRaw: typeRaw, rawEvent: rawEvent)
        }
    }

    private func executeHandler(
        _ handler: DecodeHandler,
        data: Data,
        decoder: JSONDecoder
    ) throws -> any AGUIEvent {
        do {
            return try handler(data, decoder)
        } catch let error as EventDecodingError {
            throw error
        } catch let error as DecodingError {
            throw mapDecodingError(error)
        } catch {
            throw EventDecodingError.decodingFailed(error.localizedDescription)
        }
    }

    // MARK: - Registry Management

    /// Returns the default registry of event type handlers.
    ///
    /// The default registry includes handlers for all lifecycle events:
    /// - `runStarted`, `runFinished`, `runError`
    /// - `stepStarted`, `stepFinished`
    ///
    /// Additional event categories (text messages, tool calls, state management, etc.)
    /// can be added by composing multiple registries together.
    ///
    /// - Returns: A dictionary mapping `EventType` to `DecodeHandler` functions
    ///
    /// Example of composing custom registries:
    /// ```swift
    /// let customRegistry = RegistryComposer.compose(
    ///     AGUIEventDecoder.defaultRegistry(),
    ///     MyCustomEventRegistry.registry()
    /// )
    /// let decoder = AGUIEventDecoder(registry: customRegistry)
    /// ```
    public static func defaultRegistry() -> [EventType: DecodeHandler] {
        RegistryComposer.compose(
            LifecycleEventRegistry.registry(),
            TextMessageEventRegistry.registry(),
            ToolCallEventRegistry.registry(),
            StateEventRegistry.registry(),
            SpecialEventRegistry.registry(),
            ThinkingEventRegistry.registry(),
            ActivityEventRegistry.registry()
        )
    }

    // MARK: - Error mapping

    private func mapDecodingError(_ error: DecodingError) -> EventDecodingError {
        func path(_ codingPath: [CodingKey]) -> String {
            let pathString = codingPath.map(\.stringValue).joined(separator: ".")
            return pathString.isEmpty ? "root" : pathString
        }

        switch error {
        case .keyNotFound(let key, _) where key.stringValue == "type":
            return .missingTypeField
        case .dataCorrupted:
            return .invalidJSON
        case .keyNotFound(let key, let ctx):
            return .decodingFailed("Missing key '\(key.stringValue)' at \(path(ctx.codingPath))")
        case .typeMismatch(let type, let ctx):
            return .decodingFailed("Type mismatch '\(type)' at \(path(ctx.codingPath))")
        case .valueNotFound(let type, let ctx):
            return .decodingFailed("Missing value '\(type)' at \(path(ctx.codingPath))")
        @unknown default:
            return .decodingFailed(String(describing: error))
        }
    }
}
