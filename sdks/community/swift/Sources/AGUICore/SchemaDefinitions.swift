import Foundation

/// Strongly named AG-UI 1.0 definitions with typed accessors for declared fields.
public protocol AGUI1Definition {
    static var definitionName: String { get }
    var document: AGUISchemaDocument { get }
    init(document: AGUISchemaDocument) throws
    init(_ data: Data) throws
}

public extension AGUI1Definition {
    init(_ data: Data) throws { try self.init(document: AGUISchemaDocument(data, definition: Self.definitionName)) }
    init(forwardCompatible data: Data) throws {
        try self.init(document: AGUISchemaDocument(data, definition: Self.definitionName, allowUnknownFields: true))
    }
    func encoded() throws -> Data { try document.encoded() }
    var jsonValue: AGUIJSON { document.json }
}

private enum AGUI1Nested {
    static func decode<T: AGUI1Definition>(_ value: AGUIJSON?, as type: T.Type) -> T? {
        guard let value else { return nil }
        return try? T(forwardCompatible: try value.encoded())
    }
}

public enum AGUI1EventTypeValue: String, Sendable, CaseIterable {
    case text_message_start = "TEXT_MESSAGE_START"
    case text_message_content = "TEXT_MESSAGE_CONTENT"
    case text_message_end = "TEXT_MESSAGE_END"
    case text_message_chunk = "TEXT_MESSAGE_CHUNK"
    case tool_call_start = "TOOL_CALL_START"
    case tool_call_args = "TOOL_CALL_ARGS"
    case tool_call_end = "TOOL_CALL_END"
    case tool_call_chunk = "TOOL_CALL_CHUNK"
    case tool_call_result = "TOOL_CALL_RESULT"
    case state_snapshot = "STATE_SNAPSHOT"
    case state_delta = "STATE_DELTA"
    case messages_snapshot = "MESSAGES_SNAPSHOT"
    case activity_snapshot = "ACTIVITY_SNAPSHOT"
    case activity_delta = "ACTIVITY_DELTA"
    case raw = "RAW"
    case custom = "CUSTOM"
    case run_started = "RUN_STARTED"
    case run_finished = "RUN_FINISHED"
    case run_error = "RUN_ERROR"
    case step_started = "STEP_STARTED"
    case step_finished = "STEP_FINISHED"
    case reasoning_start = "REASONING_START"
    case reasoning_message_start = "REASONING_MESSAGE_START"
    case reasoning_message_content = "REASONING_MESSAGE_CONTENT"
    case reasoning_message_end = "REASONING_MESSAGE_END"
    case reasoning_message_chunk = "REASONING_MESSAGE_CHUNK"
    case reasoning_end = "REASONING_END"
    case reasoning_encrypted_value = "REASONING_ENCRYPTED_VALUE"
    case subagent_started = "SUBAGENT_STARTED"
    case subagent_finished = "SUBAGENT_FINISHED"
    case subagent_error = "SUBAGENT_ERROR"
}

public enum AGUI1TextMessageRoleValue: String, Sendable, CaseIterable {
    case developer = "developer"
    case system = "system"
    case assistant = "assistant"
    case user = "user"
}

public enum AGUI1RoleValue: String, Sendable, CaseIterable {
    case developer = "developer"
    case system = "system"
    case assistant = "assistant"
    case user = "user"
    case tool = "tool"
    case activity = "activity"
    case reasoning = "reasoning"
}

public enum AGUI1ReasoningEncryptedValueSubtypeValue: String, Sendable, CaseIterable {
    case tool_call = "tool-call"
    case message = "message"
}

public struct AGUI1Event: AGUI1Definition {
    public static let definitionName = "Event"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var asTextMessageStartEvent: AGUI1TextMessageStartEvent? { AGUI1Nested.decode(document.json, as: AGUI1TextMessageStartEvent.self) }
    public var asTextMessageContentEvent: AGUI1TextMessageContentEvent? { AGUI1Nested.decode(document.json, as: AGUI1TextMessageContentEvent.self) }
    public var asTextMessageEndEvent: AGUI1TextMessageEndEvent? { AGUI1Nested.decode(document.json, as: AGUI1TextMessageEndEvent.self) }
    public var asTextMessageChunkEvent: AGUI1TextMessageChunkEvent? { AGUI1Nested.decode(document.json, as: AGUI1TextMessageChunkEvent.self) }
    public var asToolCallStartEvent: AGUI1ToolCallStartEvent? { AGUI1Nested.decode(document.json, as: AGUI1ToolCallStartEvent.self) }
    public var asToolCallArgsEvent: AGUI1ToolCallArgsEvent? { AGUI1Nested.decode(document.json, as: AGUI1ToolCallArgsEvent.self) }
    public var asToolCallEndEvent: AGUI1ToolCallEndEvent? { AGUI1Nested.decode(document.json, as: AGUI1ToolCallEndEvent.self) }
    public var asToolCallChunkEvent: AGUI1ToolCallChunkEvent? { AGUI1Nested.decode(document.json, as: AGUI1ToolCallChunkEvent.self) }
    public var asToolCallResultEvent: AGUI1ToolCallResultEvent? { AGUI1Nested.decode(document.json, as: AGUI1ToolCallResultEvent.self) }
    public var asStateSnapshotEvent: AGUI1StateSnapshotEvent? { AGUI1Nested.decode(document.json, as: AGUI1StateSnapshotEvent.self) }
    public var asStateDeltaEvent: AGUI1StateDeltaEvent? { AGUI1Nested.decode(document.json, as: AGUI1StateDeltaEvent.self) }
    public var asMessagesSnapshotEvent: AGUI1MessagesSnapshotEvent? { AGUI1Nested.decode(document.json, as: AGUI1MessagesSnapshotEvent.self) }
    public var asActivitySnapshotEvent: AGUI1ActivitySnapshotEvent? { AGUI1Nested.decode(document.json, as: AGUI1ActivitySnapshotEvent.self) }
    public var asActivityDeltaEvent: AGUI1ActivityDeltaEvent? { AGUI1Nested.decode(document.json, as: AGUI1ActivityDeltaEvent.self) }
    public var asRawEvent: AGUI1RawEvent? { AGUI1Nested.decode(document.json, as: AGUI1RawEvent.self) }
    public var asCustomEvent: AGUI1CustomEvent? { AGUI1Nested.decode(document.json, as: AGUI1CustomEvent.self) }
    public var asRunStartedEvent: AGUI1RunStartedEvent? { AGUI1Nested.decode(document.json, as: AGUI1RunStartedEvent.self) }
    public var asRunFinishedEvent: AGUI1RunFinishedEvent? { AGUI1Nested.decode(document.json, as: AGUI1RunFinishedEvent.self) }
    public var asRunErrorEvent: AGUI1RunErrorEvent? { AGUI1Nested.decode(document.json, as: AGUI1RunErrorEvent.self) }
    public var asStepStartedEvent: AGUI1StepStartedEvent? { AGUI1Nested.decode(document.json, as: AGUI1StepStartedEvent.self) }
    public var asStepFinishedEvent: AGUI1StepFinishedEvent? { AGUI1Nested.decode(document.json, as: AGUI1StepFinishedEvent.self) }
    public var asReasoningStartEvent: AGUI1ReasoningStartEvent? { AGUI1Nested.decode(document.json, as: AGUI1ReasoningStartEvent.self) }
    public var asReasoningMessageStartEvent: AGUI1ReasoningMessageStartEvent? { AGUI1Nested.decode(document.json, as: AGUI1ReasoningMessageStartEvent.self) }
    public var asReasoningMessageContentEvent: AGUI1ReasoningMessageContentEvent? { AGUI1Nested.decode(document.json, as: AGUI1ReasoningMessageContentEvent.self) }
    public var asReasoningMessageEndEvent: AGUI1ReasoningMessageEndEvent? { AGUI1Nested.decode(document.json, as: AGUI1ReasoningMessageEndEvent.self) }
    public var asReasoningMessageChunkEvent: AGUI1ReasoningMessageChunkEvent? { AGUI1Nested.decode(document.json, as: AGUI1ReasoningMessageChunkEvent.self) }
    public var asReasoningEndEvent: AGUI1ReasoningEndEvent? { AGUI1Nested.decode(document.json, as: AGUI1ReasoningEndEvent.self) }
    public var asReasoningEncryptedValueEvent: AGUI1ReasoningEncryptedValueEvent? { AGUI1Nested.decode(document.json, as: AGUI1ReasoningEncryptedValueEvent.self) }
    public var asSubagentStartedEvent: AGUI1SubagentStartedEvent? { AGUI1Nested.decode(document.json, as: AGUI1SubagentStartedEvent.self) }
    public var asSubagentFinishedEvent: AGUI1SubagentFinishedEvent? { AGUI1Nested.decode(document.json, as: AGUI1SubagentFinishedEvent.self) }
    public var asSubagentErrorEvent: AGUI1SubagentErrorEvent? { AGUI1Nested.decode(document.json, as: AGUI1SubagentErrorEvent.self) }
}

public struct AGUI1EventType: AGUI1Definition {
    public static let definitionName = "EventType"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var value: AGUI1EventTypeValue? { AGUI1EventTypeValue(rawValue: document.json.string ?? "") }
}

public struct AGUI1BaseEvent: AGUI1Definition {
    public static let definitionName = "BaseEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: AGUI1EventTypeValue? { AGUI1EventTypeValue(rawValue: document.jsonFields["type"]?.string ?? "") }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingType(_ value: AGUI1EventTypeValue?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value.rawValue) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(type: AGUI1EventTypeValue) throws {
        let values: [String: AGUIJSON] = [
            "type": .string(type.rawValue),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1Attributable: AGUI1Definition {
    public static let definitionName = "Attributable"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
}

public struct AGUI1SubagentRunId: AGUI1Definition {
    public static let definitionName = "SubagentRunId"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var value: String? { document.json.string }
}

public struct AGUI1Metadata: AGUI1Definition {
    public static let definitionName = "Metadata"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var values: [String: AGUIJSON]? { document.json.object }
}

public struct AGUI1State: AGUI1Definition {
    public static let definitionName = "State"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
}

public struct AGUI1TextMessageRole: AGUI1Definition {
    public static let definitionName = "TextMessageRole"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var value: AGUI1TextMessageRoleValue? { AGUI1TextMessageRoleValue(rawValue: document.json.string ?? "") }
}

public struct AGUI1Role: AGUI1Definition {
    public static let definitionName = "Role"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var value: AGUI1RoleValue? { AGUI1RoleValue(rawValue: document.json.string ?? "") }
}

public struct AGUI1TextMessageStartEvent: AGUI1Definition {
    public static let definitionName = "TextMessageStartEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public var role: AGUI1TextMessageRoleValue? { AGUI1TextMessageRoleValue(rawValue: document.jsonFields["role"]?.string ?? "") }
    public var name: String? { document.jsonFields["name"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public func settingRole(_ value: AGUI1TextMessageRoleValue?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value.rawValue) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public init(messageId: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("TEXT_MESSAGE_START"),
            "messageId": .string(messageId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1TextMessageContentEvent: AGUI1Definition {
    public static let definitionName = "TextMessageContentEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public var delta: String? { document.jsonFields["delta"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public func settingDelta(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("delta", to: next))
    }
    public init(messageId: String, delta: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("TEXT_MESSAGE_CONTENT"),
            "messageId": .string(messageId),
            "delta": .string(delta),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1TextMessageEndEvent: AGUI1Definition {
    public static let definitionName = "TextMessageEndEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public init(messageId: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("TEXT_MESSAGE_END"),
            "messageId": .string(messageId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1TextMessageChunkEvent: AGUI1Definition {
    public static let definitionName = "TextMessageChunkEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public var role: AGUI1TextMessageRoleValue? { AGUI1TextMessageRoleValue(rawValue: document.jsonFields["role"]?.string ?? "") }
    public var delta: String? { document.jsonFields["delta"]?.string }
    public var name: String? { document.jsonFields["name"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public func settingRole(_ value: AGUI1TextMessageRoleValue?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value.rawValue) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingDelta(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("delta", to: next))
    }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public init() throws {
        let values: [String: AGUIJSON] = [
            "type": .string("TEXT_MESSAGE_CHUNK"),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ToolCallStartEvent: AGUI1Definition {
    public static let definitionName = "ToolCallStartEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var toolCallId: String? { document.jsonFields["toolCallId"]?.string }
    public var toolCallName: String? { document.jsonFields["toolCallName"]?.string }
    public var parentMessageId: String? { document.jsonFields["parentMessageId"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingToolCallId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("toolCallId", to: next))
    }
    public func settingToolCallName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("toolCallName", to: next))
    }
    public func settingParentMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("parentMessageId", to: next))
    }
    public init(toolCallId: String, toolCallName: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("TOOL_CALL_START"),
            "toolCallId": .string(toolCallId),
            "toolCallName": .string(toolCallName),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ToolCallArgsEvent: AGUI1Definition {
    public static let definitionName = "ToolCallArgsEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var toolCallId: String? { document.jsonFields["toolCallId"]?.string }
    public var delta: String? { document.jsonFields["delta"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingToolCallId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("toolCallId", to: next))
    }
    public func settingDelta(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("delta", to: next))
    }
    public init(toolCallId: String, delta: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("TOOL_CALL_ARGS"),
            "toolCallId": .string(toolCallId),
            "delta": .string(delta),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ToolCallEndEvent: AGUI1Definition {
    public static let definitionName = "ToolCallEndEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var toolCallId: String? { document.jsonFields["toolCallId"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingToolCallId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("toolCallId", to: next))
    }
    public init(toolCallId: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("TOOL_CALL_END"),
            "toolCallId": .string(toolCallId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ToolCallChunkEvent: AGUI1Definition {
    public static let definitionName = "ToolCallChunkEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var toolCallId: String? { document.jsonFields["toolCallId"]?.string }
    public var toolCallName: String? { document.jsonFields["toolCallName"]?.string }
    public var parentMessageId: String? { document.jsonFields["parentMessageId"]?.string }
    public var delta: String? { document.jsonFields["delta"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingToolCallId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("toolCallId", to: next))
    }
    public func settingToolCallName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("toolCallName", to: next))
    }
    public func settingParentMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("parentMessageId", to: next))
    }
    public func settingDelta(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("delta", to: next))
    }
    public init() throws {
        let values: [String: AGUIJSON] = [
            "type": .string("TOOL_CALL_CHUNK"),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ToolCallResultEvent: AGUI1Definition {
    public static let definitionName = "ToolCallResultEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public var toolCallId: String? { document.jsonFields["toolCallId"]?.string }
    public var content: AGUIJSON? { document.jsonFields["content"] }
    public var role: String? { document.jsonFields["role"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public func settingToolCallId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("toolCallId", to: next))
    }
    public func settingContent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("content", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public init(messageId: String, toolCallId: String, content: AGUIJSON) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("TOOL_CALL_RESULT"),
            "role": .string("tool"),
            "messageId": .string(messageId),
            "toolCallId": .string(toolCallId),
            "content": content,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1StateSnapshotEvent: AGUI1Definition {
    public static let definitionName = "StateSnapshotEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var snapshot: AGUI1State? { AGUI1Nested.decode(document.jsonFields["snapshot"], as: AGUI1State.self) }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingSnapshot(_ value: AGUI1State?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("snapshot", to: next))
    }
    public init(snapshot: AGUI1State) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("STATE_SNAPSHOT"),
            "snapshot": snapshot.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1StateDeltaEvent: AGUI1Definition {
    public static let definitionName = "StateDeltaEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var delta: AGUI1JsonPatch? { AGUI1Nested.decode(document.jsonFields["delta"], as: AGUI1JsonPatch.self) }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingDelta(_ value: AGUI1JsonPatch?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("delta", to: next))
    }
    public init(delta: AGUI1JsonPatch) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("STATE_DELTA"),
            "delta": delta.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1MessagesSnapshotEvent: AGUI1Definition {
    public static let definitionName = "MessagesSnapshotEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var messages: [AGUI1Message]? { document.jsonFields["messages"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1Message.self) } }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingMessages(_ value: [AGUI1Message]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("messages", to: next))
    }
    public init(messages: [AGUI1Message]) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("MESSAGES_SNAPSHOT"),
            "messages": .array(messages.map { $0.document.json }),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ActivitySnapshotEvent: AGUI1Definition {
    public static let definitionName = "ActivitySnapshotEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public var activityType: String? { document.jsonFields["activityType"]?.string }
    public var content: AGUIJSON? { document.jsonFields["content"] }
    public var replace: Bool? { document.jsonFields["replace"]?.bool }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public func settingActivityType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("activityType", to: next))
    }
    public func settingContent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("content", to: next))
    }
    public func settingReplace(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("replace", to: next))
    }
    public init(messageId: String, activityType: String, content: AGUIJSON) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("ACTIVITY_SNAPSHOT"),
            "messageId": .string(messageId),
            "activityType": .string(activityType),
            "content": content,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ActivityDeltaEvent: AGUI1Definition {
    public static let definitionName = "ActivityDeltaEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public var activityType: String? { document.jsonFields["activityType"]?.string }
    public var patch: AGUI1JsonPatch? { AGUI1Nested.decode(document.jsonFields["patch"], as: AGUI1JsonPatch.self) }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public func settingActivityType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("activityType", to: next))
    }
    public func settingPatch(_ value: AGUI1JsonPatch?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("patch", to: next))
    }
    public init(messageId: String, activityType: String, patch: AGUI1JsonPatch) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("ACTIVITY_DELTA"),
            "messageId": .string(messageId),
            "activityType": .string(activityType),
            "patch": patch.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1RawEvent: AGUI1Definition {
    public static let definitionName = "RawEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var event: AGUIJSON? { document.jsonFields["event"] }
    public var source: String? { document.jsonFields["source"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("event", to: next))
    }
    public func settingSource(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("source", to: next))
    }
    public init(event: AGUIJSON) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("RAW"),
            "event": event,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1CustomEvent: AGUI1Definition {
    public static let definitionName = "CustomEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var name: String? { document.jsonFields["name"]?.string }
    public var value: AGUIJSON? { document.jsonFields["value"] }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingValue(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("value", to: next))
    }
    public init(name: String, value: AGUIJSON) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("CUSTOM"),
            "name": .string(name),
            "value": value,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1RunStartedEvent: AGUI1Definition {
    public static let definitionName = "RunStartedEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var threadId: String? { document.jsonFields["threadId"]?.string }
    public var runId: String? { document.jsonFields["runId"]?.string }
    public var protocolVersion: String? { document.jsonFields["protocolVersion"]?.string }
    public var parentRunId: String? { document.jsonFields["parentRunId"]?.string }
    public var input: AGUI1RunAgentInput? { AGUI1Nested.decode(document.jsonFields["input"], as: AGUI1RunAgentInput.self) }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingThreadId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("threadId", to: next))
    }
    public func settingRunId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("runId", to: next))
    }
    public func settingProtocolVersion(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("protocolVersion", to: next))
    }
    public func settingParentRunId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("parentRunId", to: next))
    }
    public func settingInput(_ value: AGUI1RunAgentInput?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("input", to: next))
    }
    public init(threadId: String, runId: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("RUN_STARTED"),
            "threadId": .string(threadId),
            "runId": .string(runId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1RunFinishedEvent: AGUI1Definition {
    public static let definitionName = "RunFinishedEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var threadId: String? { document.jsonFields["threadId"]?.string }
    public var runId: String? { document.jsonFields["runId"]?.string }
    public var result: AGUIJSON? { document.jsonFields["result"] }
    public var outcome: AGUI1RunFinishedOutcome? { AGUI1Nested.decode(document.jsonFields["outcome"], as: AGUI1RunFinishedOutcome.self) }
    public var usage: [AGUI1TokenUsage]? { document.jsonFields["usage"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1TokenUsage.self) } }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingThreadId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("threadId", to: next))
    }
    public func settingRunId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("runId", to: next))
    }
    public func settingResult(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("result", to: next))
    }
    public func settingOutcome(_ value: AGUI1RunFinishedOutcome?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("outcome", to: next))
    }
    public func settingUsage(_ value: [AGUI1TokenUsage]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("usage", to: next))
    }
    public init(threadId: String, runId: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("RUN_FINISHED"),
            "threadId": .string(threadId),
            "runId": .string(runId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1RunErrorEvent: AGUI1Definition {
    public static let definitionName = "RunErrorEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var message: String? { document.jsonFields["message"]?.string }
    public var code: String? { document.jsonFields["code"]?.string }
    public var usage: [AGUI1TokenUsage]? { document.jsonFields["usage"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1TokenUsage.self) } }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingMessage(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("message", to: next))
    }
    public func settingCode(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("code", to: next))
    }
    public func settingUsage(_ value: [AGUI1TokenUsage]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("usage", to: next))
    }
    public init(message: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("RUN_ERROR"),
            "message": .string(message),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1StepStartedEvent: AGUI1Definition {
    public static let definitionName = "StepStartedEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var stepName: String? { document.jsonFields["stepName"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingStepName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("stepName", to: next))
    }
    public init(stepName: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("STEP_STARTED"),
            "stepName": .string(stepName),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1StepFinishedEvent: AGUI1Definition {
    public static let definitionName = "StepFinishedEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var stepName: String? { document.jsonFields["stepName"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingStepName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("stepName", to: next))
    }
    public init(stepName: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("STEP_FINISHED"),
            "stepName": .string(stepName),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReasoningStartEvent: AGUI1Definition {
    public static let definitionName = "ReasoningStartEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public init(messageId: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("REASONING_START"),
            "messageId": .string(messageId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReasoningMessageStartEvent: AGUI1Definition {
    public static let definitionName = "ReasoningMessageStartEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public var role: String? { document.jsonFields["role"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public init(messageId: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("REASONING_MESSAGE_START"),
            "role": .string("reasoning"),
            "messageId": .string(messageId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReasoningMessageContentEvent: AGUI1Definition {
    public static let definitionName = "ReasoningMessageContentEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public var delta: String? { document.jsonFields["delta"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public func settingDelta(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("delta", to: next))
    }
    public init(messageId: String, delta: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("REASONING_MESSAGE_CONTENT"),
            "messageId": .string(messageId),
            "delta": .string(delta),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReasoningMessageEndEvent: AGUI1Definition {
    public static let definitionName = "ReasoningMessageEndEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public init(messageId: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("REASONING_MESSAGE_END"),
            "messageId": .string(messageId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReasoningMessageChunkEvent: AGUI1Definition {
    public static let definitionName = "ReasoningMessageChunkEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public var delta: String? { document.jsonFields["delta"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public func settingDelta(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("delta", to: next))
    }
    public init() throws {
        let values: [String: AGUIJSON] = [
            "type": .string("REASONING_MESSAGE_CHUNK"),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReasoningEndEvent: AGUI1Definition {
    public static let definitionName = "ReasoningEndEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var messageId: String? { document.jsonFields["messageId"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("messageId", to: next))
    }
    public init(messageId: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("REASONING_END"),
            "messageId": .string(messageId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReasoningEncryptedValueEvent: AGUI1Definition {
    public static let definitionName = "ReasoningEncryptedValueEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var subtype: AGUI1ReasoningEncryptedValueSubtypeValue? { AGUI1ReasoningEncryptedValueSubtypeValue(rawValue: document.jsonFields["subtype"]?.string ?? "") }
    public var entityId: String? { document.jsonFields["entityId"]?.string }
    public var encryptedValue: String? { document.jsonFields["encryptedValue"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingSubtype(_ value: AGUI1ReasoningEncryptedValueSubtypeValue?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value.rawValue) }
        return try Self(document: document.updating("subtype", to: next))
    }
    public func settingEntityId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("entityId", to: next))
    }
    public func settingEncryptedValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("encryptedValue", to: next))
    }
    public init(subtype: AGUI1ReasoningEncryptedValueSubtypeValue, entityId: String, encryptedValue: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("REASONING_ENCRYPTED_VALUE"),
            "subtype": .string(subtype.rawValue),
            "entityId": .string(entityId),
            "encryptedValue": .string(encryptedValue),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReasoningEncryptedValueSubtype: AGUI1Definition {
    public static let definitionName = "ReasoningEncryptedValueSubtype"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var value: AGUI1ReasoningEncryptedValueSubtypeValue? { AGUI1ReasoningEncryptedValueSubtypeValue(rawValue: document.json.string ?? "") }
}

public struct AGUI1SubagentStartedEvent: AGUI1Definition {
    public static let definitionName = "SubagentStartedEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var name: String? { document.jsonFields["name"]?.string }
    public var description: String? { document.jsonFields["description"]?.string }
    public var parentSubagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["parentSubagentRunId"], as: AGUI1SubagentRunId.self) }
    public var parentToolCallId: String? { document.jsonFields["parentToolCallId"]?.string }
    public var parentMessageId: String? { document.jsonFields["parentMessageId"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingDescription(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("description", to: next))
    }
    public func settingParentSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("parentSubagentRunId", to: next))
    }
    public func settingParentToolCallId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("parentToolCallId", to: next))
    }
    public func settingParentMessageId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("parentMessageId", to: next))
    }
    public init(subagentRunId: AGUI1SubagentRunId, name: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("SUBAGENT_STARTED"),
            "subagentRunId": subagentRunId.document.json,
            "name": .string(name),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1SubagentFinishedEvent: AGUI1Definition {
    public static let definitionName = "SubagentFinishedEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var result: AGUIJSON? { document.jsonFields["result"] }
    public var outcome: AGUI1SubagentFinishedOutcome? { AGUI1Nested.decode(document.jsonFields["outcome"], as: AGUI1SubagentFinishedOutcome.self) }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingResult(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("result", to: next))
    }
    public func settingOutcome(_ value: AGUI1SubagentFinishedOutcome?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("outcome", to: next))
    }
    public init(subagentRunId: AGUI1SubagentRunId) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("SUBAGENT_FINISHED"),
            "subagentRunId": subagentRunId.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1SubagentErrorEvent: AGUI1Definition {
    public static let definitionName = "SubagentErrorEvent"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var timestamp: Int64? { document.jsonFields["timestamp"]?.int64 }
    public var rawEvent: AGUIJSON? { document.jsonFields["rawEvent"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var message: String? { document.jsonFields["message"]?.string }
    public var code: String? { document.jsonFields["code"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingTimestamp(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("timestamp", to: next))
    }
    public func settingRawEvent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("rawEvent", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingMessage(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("message", to: next))
    }
    public func settingCode(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("code", to: next))
    }
    public init(subagentRunId: AGUI1SubagentRunId, message: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("SUBAGENT_ERROR"),
            "subagentRunId": subagentRunId.document.json,
            "message": .string(message),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1RunFinishedOutcome: AGUI1Definition {
    public static let definitionName = "RunFinishedOutcome"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var asRunFinishedSuccessOutcome: AGUI1RunFinishedSuccessOutcome? { AGUI1Nested.decode(document.json, as: AGUI1RunFinishedSuccessOutcome.self) }
    public var asRunFinishedInterruptOutcome: AGUI1RunFinishedInterruptOutcome? { AGUI1Nested.decode(document.json, as: AGUI1RunFinishedInterruptOutcome.self) }
    public var asRunFinishedCancelledOutcome: AGUI1RunFinishedCancelledOutcome? { AGUI1Nested.decode(document.json, as: AGUI1RunFinishedCancelledOutcome.self) }
}

public struct AGUI1RunFinishedSuccessOutcome: AGUI1Definition {
    public static let definitionName = "RunFinishedSuccessOutcome"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var pendingToolCallIds: [String]? { document.jsonFields["pendingToolCallIds"]?.array?.compactMap(\.string) }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingPendingToolCallIds(_ value: [String]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { .string($0) }) }
        return try Self(document: document.updating("pendingToolCallIds", to: next))
    }
    public init() throws {
        let values: [String: AGUIJSON] = [
            "type": .string("success"),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1RunFinishedInterruptOutcome: AGUI1Definition {
    public static let definitionName = "RunFinishedInterruptOutcome"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var interrupts: [AGUI1Interrupt]? { document.jsonFields["interrupts"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1Interrupt.self) } }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingInterrupts(_ value: [AGUI1Interrupt]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("interrupts", to: next))
    }
    public init(interrupts: [AGUI1Interrupt]) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("interrupt"),
            "interrupts": .array(interrupts.map { $0.document.json }),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1RunFinishedCancelledOutcome: AGUI1Definition {
    public static let definitionName = "RunFinishedCancelledOutcome"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public init() throws {
        let values: [String: AGUIJSON] = [
            "type": .string("cancelled"),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1SubagentFinishedOutcome: AGUI1Definition {
    public static let definitionName = "SubagentFinishedOutcome"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var asSubagentFinishedSuccessOutcome: AGUI1SubagentFinishedSuccessOutcome? { AGUI1Nested.decode(document.json, as: AGUI1SubagentFinishedSuccessOutcome.self) }
    public var asSubagentFinishedSuspendedOutcome: AGUI1SubagentFinishedSuspendedOutcome? { AGUI1Nested.decode(document.json, as: AGUI1SubagentFinishedSuspendedOutcome.self) }
}

public struct AGUI1SubagentFinishedSuccessOutcome: AGUI1Definition {
    public static let definitionName = "SubagentFinishedSuccessOutcome"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public init() throws {
        let values: [String: AGUIJSON] = [
            "type": .string("success"),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1SubagentFinishedSuspendedOutcome: AGUI1Definition {
    public static let definitionName = "SubagentFinishedSuspendedOutcome"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var interruptIds: [String]? { document.jsonFields["interruptIds"]?.array?.compactMap(\.string) }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingInterruptIds(_ value: [String]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { .string($0) }) }
        return try Self(document: document.updating("interruptIds", to: next))
    }
    public init() throws {
        let values: [String: AGUIJSON] = [
            "type": .string("suspended"),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1Interrupt: AGUI1Definition {
    public static let definitionName = "Interrupt"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var id: String? { document.jsonFields["id"]?.string }
    public var reason: String? { document.jsonFields["reason"]?.string }
    public var message: String? { document.jsonFields["message"]?.string }
    public var toolCallId: String? { document.jsonFields["toolCallId"]?.string }
    public var responseSchema: AGUIJSON? { document.jsonFields["responseSchema"] }
    public var expiresAt: String? { document.jsonFields["expiresAt"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingReason(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("reason", to: next))
    }
    public func settingMessage(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("message", to: next))
    }
    public func settingToolCallId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("toolCallId", to: next))
    }
    public func settingResponseSchema(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("responseSchema", to: next))
    }
    public func settingExpiresAt(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("expiresAt", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(id: String, reason: String) throws {
        let values: [String: AGUIJSON] = [
            "id": .string(id),
            "reason": .string(reason),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ResumeEntry: AGUI1Definition {
    public static let definitionName = "ResumeEntry"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var interruptId: String? { document.jsonFields["interruptId"]?.string }
    public var status: String? { document.jsonFields["status"]?.string }
    public var payload: AGUIJSON? { document.jsonFields["payload"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingInterruptId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("interruptId", to: next))
    }
    public func settingStatus(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("status", to: next))
    }
    public func settingPayload(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("payload", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(interruptId: String, status: String) throws {
        let values: [String: AGUIJSON] = [
            "interruptId": .string(interruptId),
            "status": .string(status),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1TokenUsage: AGUI1Definition {
    public static let definitionName = "TokenUsage"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var provider: String? { document.jsonFields["provider"]?.string }
    public var model: String? { document.jsonFields["model"]?.string }
    public var inputTokens: Int64? { document.jsonFields["inputTokens"]?.int64 }
    public var outputTokens: Int64? { document.jsonFields["outputTokens"]?.int64 }
    public var totalTokens: Int64? { document.jsonFields["totalTokens"]?.int64 }
    public var reasoningTokens: Int64? { document.jsonFields["reasoningTokens"]?.int64 }
    public var cachedInputTokens: Int64? { document.jsonFields["cachedInputTokens"]?.int64 }
    public var cacheWriteInputTokens: Int64? { document.jsonFields["cacheWriteInputTokens"]?.int64 }
    public func settingProvider(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("provider", to: next))
    }
    public func settingModel(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("model", to: next))
    }
    public func settingInputTokens(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("inputTokens", to: next))
    }
    public func settingOutputTokens(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("outputTokens", to: next))
    }
    public func settingTotalTokens(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("totalTokens", to: next))
    }
    public func settingReasoningTokens(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("reasoningTokens", to: next))
    }
    public func settingCachedInputTokens(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("cachedInputTokens", to: next))
    }
    public func settingCacheWriteInputTokens(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("cacheWriteInputTokens", to: next))
    }
}

public struct AGUI1Message: AGUI1Definition {
    public static let definitionName = "Message"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var asDeveloperMessage: AGUI1DeveloperMessage? { AGUI1Nested.decode(document.json, as: AGUI1DeveloperMessage.self) }
    public var asSystemMessage: AGUI1SystemMessage? { AGUI1Nested.decode(document.json, as: AGUI1SystemMessage.self) }
    public var asAssistantMessage: AGUI1AssistantMessage? { AGUI1Nested.decode(document.json, as: AGUI1AssistantMessage.self) }
    public var asUserMessage: AGUI1UserMessage? { AGUI1Nested.decode(document.json, as: AGUI1UserMessage.self) }
    public var asToolMessage: AGUI1ToolMessage? { AGUI1Nested.decode(document.json, as: AGUI1ToolMessage.self) }
    public var asActivityMessage: AGUI1ActivityMessage? { AGUI1Nested.decode(document.json, as: AGUI1ActivityMessage.self) }
    public var asReasoningMessage: AGUI1ReasoningMessage? { AGUI1Nested.decode(document.json, as: AGUI1ReasoningMessage.self) }
}

public struct AGUI1BaseMessage: AGUI1Definition {
    public static let definitionName = "BaseMessage"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var id: String? { document.jsonFields["id"]?.string }
    public var role: String? { document.jsonFields["role"]?.string }
    public var name: String? { document.jsonFields["name"]?.string }
    public var encryptedValue: String? { document.jsonFields["encryptedValue"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingEncryptedValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("encryptedValue", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(id: String, role: String) throws {
        let values: [String: AGUIJSON] = [
            "id": .string(id),
            "role": .string(role),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1DeveloperMessage: AGUI1Definition {
    public static let definitionName = "DeveloperMessage"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var id: String? { document.jsonFields["id"]?.string }
    public var role: String? { document.jsonFields["role"]?.string }
    public var name: String? { document.jsonFields["name"]?.string }
    public var encryptedValue: String? { document.jsonFields["encryptedValue"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var content: String? { document.jsonFields["content"]?.string }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingEncryptedValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("encryptedValue", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingContent(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("content", to: next))
    }
    public init(id: String, content: String) throws {
        let values: [String: AGUIJSON] = [
            "role": .string("developer"),
            "id": .string(id),
            "content": .string(content),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1SystemMessage: AGUI1Definition {
    public static let definitionName = "SystemMessage"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var id: String? { document.jsonFields["id"]?.string }
    public var role: String? { document.jsonFields["role"]?.string }
    public var name: String? { document.jsonFields["name"]?.string }
    public var encryptedValue: String? { document.jsonFields["encryptedValue"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var content: String? { document.jsonFields["content"]?.string }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingEncryptedValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("encryptedValue", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingContent(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("content", to: next))
    }
    public init(id: String, content: String) throws {
        let values: [String: AGUIJSON] = [
            "role": .string("system"),
            "id": .string(id),
            "content": .string(content),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1AssistantMessage: AGUI1Definition {
    public static let definitionName = "AssistantMessage"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var id: String? { document.jsonFields["id"]?.string }
    public var role: String? { document.jsonFields["role"]?.string }
    public var name: String? { document.jsonFields["name"]?.string }
    public var encryptedValue: String? { document.jsonFields["encryptedValue"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var content: String? { document.jsonFields["content"]?.string }
    public var toolCalls: [AGUI1ToolCall]? { document.jsonFields["toolCalls"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1ToolCall.self) } }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingEncryptedValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("encryptedValue", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingContent(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("content", to: next))
    }
    public func settingToolCalls(_ value: [AGUI1ToolCall]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("toolCalls", to: next))
    }
    public init(id: String) throws {
        let values: [String: AGUIJSON] = [
            "role": .string("assistant"),
            "id": .string(id),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1UserMessage: AGUI1Definition {
    public static let definitionName = "UserMessage"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var id: String? { document.jsonFields["id"]?.string }
    public var role: String? { document.jsonFields["role"]?.string }
    public var name: String? { document.jsonFields["name"]?.string }
    public var encryptedValue: String? { document.jsonFields["encryptedValue"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public var content: AGUIJSON? { document.jsonFields["content"] }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingEncryptedValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("encryptedValue", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public func settingContent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("content", to: next))
    }
    public init(id: String, content: AGUIJSON) throws {
        let values: [String: AGUIJSON] = [
            "role": .string("user"),
            "id": .string(id),
            "content": content,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ToolMessage: AGUI1Definition {
    public static let definitionName = "ToolMessage"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var id: String? { document.jsonFields["id"]?.string }
    public var role: String? { document.jsonFields["role"]?.string }
    public var content: AGUIJSON? { document.jsonFields["content"] }
    public var toolCallId: String? { document.jsonFields["toolCallId"]?.string }
    public var error: String? { document.jsonFields["error"]?.string }
    public var encryptedValue: String? { document.jsonFields["encryptedValue"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingContent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("content", to: next))
    }
    public func settingToolCallId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("toolCallId", to: next))
    }
    public func settingError(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("error", to: next))
    }
    public func settingEncryptedValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("encryptedValue", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(id: String, content: AGUIJSON, toolCallId: String) throws {
        let values: [String: AGUIJSON] = [
            "role": .string("tool"),
            "id": .string(id),
            "content": content,
            "toolCallId": .string(toolCallId),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ActivityMessage: AGUI1Definition {
    public static let definitionName = "ActivityMessage"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var id: String? { document.jsonFields["id"]?.string }
    public var role: String? { document.jsonFields["role"]?.string }
    public var activityType: String? { document.jsonFields["activityType"]?.string }
    public var content: AGUIJSON? { document.jsonFields["content"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingActivityType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("activityType", to: next))
    }
    public func settingContent(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("content", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(id: String, activityType: String, content: AGUIJSON) throws {
        let values: [String: AGUIJSON] = [
            "role": .string("activity"),
            "id": .string(id),
            "activityType": .string(activityType),
            "content": content,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReasoningMessage: AGUI1Definition {
    public static let definitionName = "ReasoningMessage"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var subagentRunId: AGUI1SubagentRunId? { AGUI1Nested.decode(document.jsonFields["subagentRunId"], as: AGUI1SubagentRunId.self) }
    public var id: String? { document.jsonFields["id"]?.string }
    public var role: String? { document.jsonFields["role"]?.string }
    public var content: String? { document.jsonFields["content"]?.string }
    public var encryptedValue: String? { document.jsonFields["encryptedValue"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingSubagentRunId(_ value: AGUI1SubagentRunId?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("subagentRunId", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingRole(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("role", to: next))
    }
    public func settingContent(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("content", to: next))
    }
    public func settingEncryptedValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("encryptedValue", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(id: String, content: String) throws {
        let values: [String: AGUIJSON] = [
            "role": .string("reasoning"),
            "id": .string(id),
            "content": .string(content),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ToolCall: AGUI1Definition {
    public static let definitionName = "ToolCall"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var id: String? { document.jsonFields["id"]?.string }
    public var type: String? { document.jsonFields["type"]?.string }
    public var function: AGUI1FunctionCall? { AGUI1Nested.decode(document.jsonFields["function"], as: AGUI1FunctionCall.self) }
    public var encryptedValue: String? { document.jsonFields["encryptedValue"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingFunction(_ value: AGUI1FunctionCall?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("function", to: next))
    }
    public func settingEncryptedValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("encryptedValue", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(id: String, function: AGUI1FunctionCall) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("function"),
            "id": .string(id),
            "function": function.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1FunctionCall: AGUI1Definition {
    public static let definitionName = "FunctionCall"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var name: String? { document.jsonFields["name"]?.string }
    public var arguments: String? { document.jsonFields["arguments"]?.string }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingArguments(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("arguments", to: next))
    }
    public init(name: String, arguments: String) throws {
        let values: [String: AGUIJSON] = [
            "name": .string(name),
            "arguments": .string(arguments),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ContentPart: AGUI1Definition {
    public static let definitionName = "ContentPart"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var asTextPart: AGUI1TextPart? { AGUI1Nested.decode(document.json, as: AGUI1TextPart.self) }
    public var asImagePart: AGUI1ImagePart? { AGUI1Nested.decode(document.json, as: AGUI1ImagePart.self) }
    public var asAudioPart: AGUI1AudioPart? { AGUI1Nested.decode(document.json, as: AGUI1AudioPart.self) }
    public var asVideoPart: AGUI1VideoPart? { AGUI1Nested.decode(document.json, as: AGUI1VideoPart.self) }
    public var asDocumentPart: AGUI1DocumentPart? { AGUI1Nested.decode(document.json, as: AGUI1DocumentPart.self) }
}

public struct AGUI1TextPart: AGUI1Definition {
    public static let definitionName = "TextPart"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var id: String? { document.jsonFields["id"]?.string }
    public var text: String? { document.jsonFields["text"]?.string }
    public var metadata: AGUIJSON? { document.jsonFields["metadata"] }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingText(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("text", to: next))
    }
    public func settingMetadata(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(text: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("text"),
            "text": .string(text),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ImagePart: AGUI1Definition {
    public static let definitionName = "ImagePart"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var id: String? { document.jsonFields["id"]?.string }
    public var source: AGUI1PartSource? { AGUI1Nested.decode(document.jsonFields["source"], as: AGUI1PartSource.self) }
    public var metadata: AGUIJSON? { document.jsonFields["metadata"] }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingSource(_ value: AGUI1PartSource?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("source", to: next))
    }
    public func settingMetadata(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(source: AGUI1PartSource) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("image"),
            "source": source.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1AudioPart: AGUI1Definition {
    public static let definitionName = "AudioPart"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var id: String? { document.jsonFields["id"]?.string }
    public var source: AGUI1PartSource? { AGUI1Nested.decode(document.jsonFields["source"], as: AGUI1PartSource.self) }
    public var metadata: AGUIJSON? { document.jsonFields["metadata"] }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingSource(_ value: AGUI1PartSource?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("source", to: next))
    }
    public func settingMetadata(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(source: AGUI1PartSource) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("audio"),
            "source": source.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1VideoPart: AGUI1Definition {
    public static let definitionName = "VideoPart"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var id: String? { document.jsonFields["id"]?.string }
    public var source: AGUI1PartSource? { AGUI1Nested.decode(document.jsonFields["source"], as: AGUI1PartSource.self) }
    public var metadata: AGUIJSON? { document.jsonFields["metadata"] }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingSource(_ value: AGUI1PartSource?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("source", to: next))
    }
    public func settingMetadata(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(source: AGUI1PartSource) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("video"),
            "source": source.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1DocumentPart: AGUI1Definition {
    public static let definitionName = "DocumentPart"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var id: String? { document.jsonFields["id"]?.string }
    public var source: AGUI1PartSource? { AGUI1Nested.decode(document.jsonFields["source"], as: AGUI1PartSource.self) }
    public var metadata: AGUIJSON? { document.jsonFields["metadata"] }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("id", to: next))
    }
    public func settingSource(_ value: AGUI1PartSource?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("source", to: next))
    }
    public func settingMetadata(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(source: AGUI1PartSource) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("document"),
            "source": source.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1PartSource: AGUI1Definition {
    public static let definitionName = "PartSource"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var asDataSource: AGUI1DataSource? { AGUI1Nested.decode(document.json, as: AGUI1DataSource.self) }
    public var asUrlSource: AGUI1UrlSource? { AGUI1Nested.decode(document.json, as: AGUI1UrlSource.self) }
    public var asFileSource: AGUI1FileSource? { AGUI1Nested.decode(document.json, as: AGUI1FileSource.self) }
}

public struct AGUI1DataSource: AGUI1Definition {
    public static let definitionName = "DataSource"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var value: String? { document.jsonFields["value"]?.string }
    public var mimeType: String? { document.jsonFields["mimeType"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("value", to: next))
    }
    public func settingMimeType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("mimeType", to: next))
    }
    public init(value: String, mimeType: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("data"),
            "value": .string(value),
            "mimeType": .string(mimeType),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1UrlSource: AGUI1Definition {
    public static let definitionName = "UrlSource"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var value: String? { document.jsonFields["value"]?.string }
    public var mimeType: String? { document.jsonFields["mimeType"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("value", to: next))
    }
    public func settingMimeType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("mimeType", to: next))
    }
    public init(value: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("url"),
            "value": .string(value),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1FileSource: AGUI1Definition {
    public static let definitionName = "FileSource"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var type: String? { document.jsonFields["type"]?.string }
    public var value: String? { document.jsonFields["value"]?.string }
    public var provider: String? { document.jsonFields["provider"]?.string }
    public var mimeType: String? { document.jsonFields["mimeType"]?.string }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("value", to: next))
    }
    public func settingProvider(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("provider", to: next))
    }
    public func settingMimeType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("mimeType", to: next))
    }
    public init(value: String) throws {
        let values: [String: AGUIJSON] = [
            "type": .string("file"),
            "value": .string(value),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1Context: AGUI1Definition {
    public static let definitionName = "Context"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var description: String? { document.jsonFields["description"]?.string }
    public var value: String? { document.jsonFields["value"]?.string }
    public func settingDescription(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("description", to: next))
    }
    public func settingValue(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("value", to: next))
    }
    public init(description: String, value: String) throws {
        let values: [String: AGUIJSON] = [
            "description": .string(description),
            "value": .string(value),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1Tool: AGUI1Definition {
    public static let definitionName = "Tool"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var name: String? { document.jsonFields["name"]?.string }
    public var description: String? { document.jsonFields["description"]?.string }
    public var parameters: AGUIJSON? { document.jsonFields["parameters"] }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingDescription(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("description", to: next))
    }
    public func settingParameters(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("parameters", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
    public init(name: String, description: String) throws {
        let values: [String: AGUIJSON] = [
            "name": .string(name),
            "description": .string(description),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1RunAgentInput: AGUI1Definition {
    public static let definitionName = "RunAgentInput"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var threadId: String? { document.jsonFields["threadId"]?.string }
    public var runId: String? { document.jsonFields["runId"]?.string }
    public var protocolVersion: String? { document.jsonFields["protocolVersion"]?.string }
    public var parentRunId: String? { document.jsonFields["parentRunId"]?.string }
    public var state: AGUI1State? { AGUI1Nested.decode(document.jsonFields["state"], as: AGUI1State.self) }
    public var messages: [AGUI1Message]? { document.jsonFields["messages"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1Message.self) } }
    public var tools: [AGUI1Tool]? { document.jsonFields["tools"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1Tool.self) } }
    public var context: [AGUI1Context]? { document.jsonFields["context"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1Context.self) } }
    public var forwardedProps: AGUIJSON? { document.jsonFields["forwardedProps"] }
    public var resume: [AGUI1ResumeEntry]? { document.jsonFields["resume"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1ResumeEntry.self) } }
    public func settingThreadId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("threadId", to: next))
    }
    public func settingRunId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("runId", to: next))
    }
    public func settingProtocolVersion(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("protocolVersion", to: next))
    }
    public func settingParentRunId(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("parentRunId", to: next))
    }
    public func settingState(_ value: AGUI1State?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("state", to: next))
    }
    public func settingMessages(_ value: [AGUI1Message]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("messages", to: next))
    }
    public func settingTools(_ value: [AGUI1Tool]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("tools", to: next))
    }
    public func settingContext(_ value: [AGUI1Context]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("context", to: next))
    }
    public func settingForwardedProps(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("forwardedProps", to: next))
    }
    public func settingResume(_ value: [AGUI1ResumeEntry]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("resume", to: next))
    }
    public init(threadId: String, runId: String, messages: [AGUI1Message]) throws {
        let values: [String: AGUIJSON] = [
            "threadId": .string(threadId),
            "runId": .string(runId),
            "messages": .array(messages.map { $0.document.json }),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1SubagentInfo: AGUI1Definition {
    public static let definitionName = "SubagentInfo"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var name: String? { document.jsonFields["name"]?.string }
    public var description: String? { document.jsonFields["description"]?.string }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingDescription(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("description", to: next))
    }
    public init(name: String) throws {
        let values: [String: AGUIJSON] = [
            "name": .string(name),
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1IdentityCapabilities: AGUI1Definition {
    public static let definitionName = "IdentityCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var name: String? { document.jsonFields["name"]?.string }
    public var type: String? { document.jsonFields["type"]?.string }
    public var description: String? { document.jsonFields["description"]?.string }
    public var version: String? { document.jsonFields["version"]?.string }
    public var provider: String? { document.jsonFields["provider"]?.string }
    public var documentationUrl: String? { document.jsonFields["documentationUrl"]?.string }
    public var metadata: AGUI1Metadata? { AGUI1Nested.decode(document.jsonFields["metadata"], as: AGUI1Metadata.self) }
    public func settingName(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("name", to: next))
    }
    public func settingType(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("type", to: next))
    }
    public func settingDescription(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("description", to: next))
    }
    public func settingVersion(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("version", to: next))
    }
    public func settingProvider(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("provider", to: next))
    }
    public func settingDocumentationUrl(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("documentationUrl", to: next))
    }
    public func settingMetadata(_ value: AGUI1Metadata?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("metadata", to: next))
    }
}

public struct AGUI1TransportCapabilities: AGUI1Definition {
    public static let definitionName = "TransportCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var streaming: Bool? { document.jsonFields["streaming"]?.bool }
    public var websocket: Bool? { document.jsonFields["websocket"]?.bool }
    public var httpBinary: Bool? { document.jsonFields["httpBinary"]?.bool }
    public var pushNotifications: Bool? { document.jsonFields["pushNotifications"]?.bool }
    public var resumable: Bool? { document.jsonFields["resumable"]?.bool }
    public func settingStreaming(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("streaming", to: next))
    }
    public func settingWebsocket(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("websocket", to: next))
    }
    public func settingHttpBinary(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("httpBinary", to: next))
    }
    public func settingPushNotifications(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("pushNotifications", to: next))
    }
    public func settingResumable(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("resumable", to: next))
    }
}

public struct AGUI1ToolsCapabilities: AGUI1Definition {
    public static let definitionName = "ToolsCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var supported: Bool? { document.jsonFields["supported"]?.bool }
    public var items: [AGUI1Tool]? { document.jsonFields["items"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1Tool.self) } }
    public var parallelCalls: Bool? { document.jsonFields["parallelCalls"]?.bool }
    public var clientProvided: Bool? { document.jsonFields["clientProvided"]?.bool }
    public func settingSupported(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("supported", to: next))
    }
    public func settingItems(_ value: [AGUI1Tool]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("items", to: next))
    }
    public func settingParallelCalls(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("parallelCalls", to: next))
    }
    public func settingClientProvided(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("clientProvided", to: next))
    }
}

public struct AGUI1OutputCapabilities: AGUI1Definition {
    public static let definitionName = "OutputCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var structuredOutput: Bool? { document.jsonFields["structuredOutput"]?.bool }
    public var supportedMimeTypes: [String]? { document.jsonFields["supportedMimeTypes"]?.array?.compactMap(\.string) }
    public func settingStructuredOutput(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("structuredOutput", to: next))
    }
    public func settingSupportedMimeTypes(_ value: [String]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { .string($0) }) }
        return try Self(document: document.updating("supportedMimeTypes", to: next))
    }
}

public struct AGUI1StateCapabilities: AGUI1Definition {
    public static let definitionName = "StateCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var snapshots: Bool? { document.jsonFields["snapshots"]?.bool }
    public var deltas: Bool? { document.jsonFields["deltas"]?.bool }
    public var memory: Bool? { document.jsonFields["memory"]?.bool }
    public var persistentState: Bool? { document.jsonFields["persistentState"]?.bool }
    public func settingSnapshots(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("snapshots", to: next))
    }
    public func settingDeltas(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("deltas", to: next))
    }
    public func settingMemory(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("memory", to: next))
    }
    public func settingPersistentState(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("persistentState", to: next))
    }
}

public struct AGUI1MultiAgentCapabilities: AGUI1Definition {
    public static let definitionName = "MultiAgentCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var supported: Bool? { document.jsonFields["supported"]?.bool }
    public var delegation: Bool? { document.jsonFields["delegation"]?.bool }
    public var handoffs: Bool? { document.jsonFields["handoffs"]?.bool }
    public var subagents: [AGUI1SubagentInfo]? { document.jsonFields["subagents"]?.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1SubagentInfo.self) } }
    public func settingSupported(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("supported", to: next))
    }
    public func settingDelegation(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("delegation", to: next))
    }
    public func settingHandoffs(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("handoffs", to: next))
    }
    public func settingSubagents(_ value: [AGUI1SubagentInfo]?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .array(value.map { $0.document.json }) }
        return try Self(document: document.updating("subagents", to: next))
    }
}

public struct AGUI1ReasoningCapabilities: AGUI1Definition {
    public static let definitionName = "ReasoningCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var supported: Bool? { document.jsonFields["supported"]?.bool }
    public var streaming: Bool? { document.jsonFields["streaming"]?.bool }
    public var encrypted: Bool? { document.jsonFields["encrypted"]?.bool }
    public func settingSupported(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("supported", to: next))
    }
    public func settingStreaming(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("streaming", to: next))
    }
    public func settingEncrypted(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("encrypted", to: next))
    }
}

public struct AGUI1MultimodalInputCapabilities: AGUI1Definition {
    public static let definitionName = "MultimodalInputCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var image: Bool? { document.jsonFields["image"]?.bool }
    public var audio: Bool? { document.jsonFields["audio"]?.bool }
    public var video: Bool? { document.jsonFields["video"]?.bool }
    public var pdf: Bool? { document.jsonFields["pdf"]?.bool }
    public var file: Bool? { document.jsonFields["file"]?.bool }
    public func settingImage(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("image", to: next))
    }
    public func settingAudio(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("audio", to: next))
    }
    public func settingVideo(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("video", to: next))
    }
    public func settingPdf(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("pdf", to: next))
    }
    public func settingFile(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("file", to: next))
    }
}

public struct AGUI1MultimodalOutputCapabilities: AGUI1Definition {
    public static let definitionName = "MultimodalOutputCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var image: Bool? { document.jsonFields["image"]?.bool }
    public var audio: Bool? { document.jsonFields["audio"]?.bool }
    public func settingImage(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("image", to: next))
    }
    public func settingAudio(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("audio", to: next))
    }
}

public struct AGUI1MultimodalCapabilities: AGUI1Definition {
    public static let definitionName = "MultimodalCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var input: AGUI1MultimodalInputCapabilities? { AGUI1Nested.decode(document.jsonFields["input"], as: AGUI1MultimodalInputCapabilities.self) }
    public var output: AGUI1MultimodalOutputCapabilities? { AGUI1Nested.decode(document.jsonFields["output"], as: AGUI1MultimodalOutputCapabilities.self) }
    public func settingInput(_ value: AGUI1MultimodalInputCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("input", to: next))
    }
    public func settingOutput(_ value: AGUI1MultimodalOutputCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("output", to: next))
    }
}

public struct AGUI1ExecutionCapabilities: AGUI1Definition {
    public static let definitionName = "ExecutionCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var codeExecution: Bool? { document.jsonFields["codeExecution"]?.bool }
    public var sandboxed: Bool? { document.jsonFields["sandboxed"]?.bool }
    public var maxIterations: Int64? { document.jsonFields["maxIterations"]?.int64 }
    public var maxExecutionTime: Int64? { document.jsonFields["maxExecutionTime"]?.int64 }
    public func settingCodeExecution(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("codeExecution", to: next))
    }
    public func settingSandboxed(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("sandboxed", to: next))
    }
    public func settingMaxIterations(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("maxIterations", to: next))
    }
    public func settingMaxExecutionTime(_ value: Int64?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .number(String(value)) }
        return try Self(document: document.updating("maxExecutionTime", to: next))
    }
}

public struct AGUI1HumanInTheLoopCapabilities: AGUI1Definition {
    public static let definitionName = "HumanInTheLoopCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var supported: Bool? { document.jsonFields["supported"]?.bool }
    public var approvals: Bool? { document.jsonFields["approvals"]?.bool }
    public var interventions: Bool? { document.jsonFields["interventions"]?.bool }
    public var feedback: Bool? { document.jsonFields["feedback"]?.bool }
    public var interrupts: Bool? { document.jsonFields["interrupts"]?.bool }
    public var approveWithEdits: Bool? { document.jsonFields["approveWithEdits"]?.bool }
    public func settingSupported(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("supported", to: next))
    }
    public func settingApprovals(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("approvals", to: next))
    }
    public func settingInterventions(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("interventions", to: next))
    }
    public func settingFeedback(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("feedback", to: next))
    }
    public func settingInterrupts(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("interrupts", to: next))
    }
    public func settingApproveWithEdits(_ value: Bool?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .bool(value) }
        return try Self(document: document.updating("approveWithEdits", to: next))
    }
}

public struct AGUI1AgentCapabilities: AGUI1Definition {
    public static let definitionName = "AgentCapabilities"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var identity: AGUI1IdentityCapabilities? { AGUI1Nested.decode(document.jsonFields["identity"], as: AGUI1IdentityCapabilities.self) }
    public var transport: AGUI1TransportCapabilities? { AGUI1Nested.decode(document.jsonFields["transport"], as: AGUI1TransportCapabilities.self) }
    public var tools: AGUI1ToolsCapabilities? { AGUI1Nested.decode(document.jsonFields["tools"], as: AGUI1ToolsCapabilities.self) }
    public var output: AGUI1OutputCapabilities? { AGUI1Nested.decode(document.jsonFields["output"], as: AGUI1OutputCapabilities.self) }
    public var state: AGUI1StateCapabilities? { AGUI1Nested.decode(document.jsonFields["state"], as: AGUI1StateCapabilities.self) }
    public var multiAgent: AGUI1MultiAgentCapabilities? { AGUI1Nested.decode(document.jsonFields["multiAgent"], as: AGUI1MultiAgentCapabilities.self) }
    public var reasoning: AGUI1ReasoningCapabilities? { AGUI1Nested.decode(document.jsonFields["reasoning"], as: AGUI1ReasoningCapabilities.self) }
    public var multimodal: AGUI1MultimodalCapabilities? { AGUI1Nested.decode(document.jsonFields["multimodal"], as: AGUI1MultimodalCapabilities.self) }
    public var execution: AGUI1ExecutionCapabilities? { AGUI1Nested.decode(document.jsonFields["execution"], as: AGUI1ExecutionCapabilities.self) }
    public var humanInTheLoop: AGUI1HumanInTheLoopCapabilities? { AGUI1Nested.decode(document.jsonFields["humanInTheLoop"], as: AGUI1HumanInTheLoopCapabilities.self) }
    public var custom: AGUIJSON? { document.jsonFields["custom"] }
    public func settingIdentity(_ value: AGUI1IdentityCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("identity", to: next))
    }
    public func settingTransport(_ value: AGUI1TransportCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("transport", to: next))
    }
    public func settingTools(_ value: AGUI1ToolsCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("tools", to: next))
    }
    public func settingOutput(_ value: AGUI1OutputCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("output", to: next))
    }
    public func settingState(_ value: AGUI1StateCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("state", to: next))
    }
    public func settingMultiAgent(_ value: AGUI1MultiAgentCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("multiAgent", to: next))
    }
    public func settingReasoning(_ value: AGUI1ReasoningCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("reasoning", to: next))
    }
    public func settingMultimodal(_ value: AGUI1MultimodalCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("multimodal", to: next))
    }
    public func settingExecution(_ value: AGUI1ExecutionCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("execution", to: next))
    }
    public func settingHumanInTheLoop(_ value: AGUI1HumanInTheLoopCapabilities?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("humanInTheLoop", to: next))
    }
    public func settingCustom(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("custom", to: next))
    }
}

public struct AGUI1JsonPatch: AGUI1Definition {
    public static let definitionName = "JsonPatch"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var items: [AGUI1JsonPatchOperation]? { document.json.array?.compactMap { AGUI1Nested.decode($0, as: AGUI1JsonPatchOperation.self) } }
}

public struct AGUI1JsonPatchOperation: AGUI1Definition {
    public static let definitionName = "JsonPatchOperation"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var asAddOperation: AGUI1AddOperation? { AGUI1Nested.decode(document.json, as: AGUI1AddOperation.self) }
    public var asRemoveOperation: AGUI1RemoveOperation? { AGUI1Nested.decode(document.json, as: AGUI1RemoveOperation.self) }
    public var asReplaceOperation: AGUI1ReplaceOperation? { AGUI1Nested.decode(document.json, as: AGUI1ReplaceOperation.self) }
    public var asMoveOperation: AGUI1MoveOperation? { AGUI1Nested.decode(document.json, as: AGUI1MoveOperation.self) }
    public var asCopyOperation: AGUI1CopyOperation? { AGUI1Nested.decode(document.json, as: AGUI1CopyOperation.self) }
    public var asTestOperation: AGUI1TestOperation? { AGUI1Nested.decode(document.json, as: AGUI1TestOperation.self) }
}

public struct AGUI1AddOperation: AGUI1Definition {
    public static let definitionName = "AddOperation"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var op: String? { document.jsonFields["op"]?.string }
    public var path: AGUI1JsonPointer? { AGUI1Nested.decode(document.jsonFields["path"], as: AGUI1JsonPointer.self) }
    public var value: AGUIJSON? { document.jsonFields["value"] }
    public func settingOp(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("op", to: next))
    }
    public func settingPath(_ value: AGUI1JsonPointer?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("path", to: next))
    }
    public func settingValue(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("value", to: next))
    }
    public init(path: AGUI1JsonPointer, value: AGUIJSON) throws {
        let values: [String: AGUIJSON] = [
            "op": .string("add"),
            "path": path.document.json,
            "value": value,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1RemoveOperation: AGUI1Definition {
    public static let definitionName = "RemoveOperation"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var op: String? { document.jsonFields["op"]?.string }
    public var path: AGUI1JsonPointer? { AGUI1Nested.decode(document.jsonFields["path"], as: AGUI1JsonPointer.self) }
    public func settingOp(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("op", to: next))
    }
    public func settingPath(_ value: AGUI1JsonPointer?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("path", to: next))
    }
    public init(path: AGUI1JsonPointer) throws {
        let values: [String: AGUIJSON] = [
            "op": .string("remove"),
            "path": path.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1ReplaceOperation: AGUI1Definition {
    public static let definitionName = "ReplaceOperation"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var op: String? { document.jsonFields["op"]?.string }
    public var path: AGUI1JsonPointer? { AGUI1Nested.decode(document.jsonFields["path"], as: AGUI1JsonPointer.self) }
    public var value: AGUIJSON? { document.jsonFields["value"] }
    public func settingOp(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("op", to: next))
    }
    public func settingPath(_ value: AGUI1JsonPointer?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("path", to: next))
    }
    public func settingValue(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("value", to: next))
    }
    public init(path: AGUI1JsonPointer, value: AGUIJSON) throws {
        let values: [String: AGUIJSON] = [
            "op": .string("replace"),
            "path": path.document.json,
            "value": value,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1MoveOperation: AGUI1Definition {
    public static let definitionName = "MoveOperation"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var op: String? { document.jsonFields["op"]?.string }
    public var from: AGUI1JsonPointer? { AGUI1Nested.decode(document.jsonFields["from"], as: AGUI1JsonPointer.self) }
    public var path: AGUI1JsonPointer? { AGUI1Nested.decode(document.jsonFields["path"], as: AGUI1JsonPointer.self) }
    public func settingOp(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("op", to: next))
    }
    public func settingFrom(_ value: AGUI1JsonPointer?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("from", to: next))
    }
    public func settingPath(_ value: AGUI1JsonPointer?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("path", to: next))
    }
    public init(from: AGUI1JsonPointer, path: AGUI1JsonPointer) throws {
        let values: [String: AGUIJSON] = [
            "op": .string("move"),
            "from": from.document.json,
            "path": path.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1CopyOperation: AGUI1Definition {
    public static let definitionName = "CopyOperation"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var op: String? { document.jsonFields["op"]?.string }
    public var from: AGUI1JsonPointer? { AGUI1Nested.decode(document.jsonFields["from"], as: AGUI1JsonPointer.self) }
    public var path: AGUI1JsonPointer? { AGUI1Nested.decode(document.jsonFields["path"], as: AGUI1JsonPointer.self) }
    public func settingOp(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("op", to: next))
    }
    public func settingFrom(_ value: AGUI1JsonPointer?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("from", to: next))
    }
    public func settingPath(_ value: AGUI1JsonPointer?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("path", to: next))
    }
    public init(from: AGUI1JsonPointer, path: AGUI1JsonPointer) throws {
        let values: [String: AGUIJSON] = [
            "op": .string("copy"),
            "from": from.document.json,
            "path": path.document.json,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1TestOperation: AGUI1Definition {
    public static let definitionName = "TestOperation"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var op: String? { document.jsonFields["op"]?.string }
    public var path: AGUI1JsonPointer? { AGUI1Nested.decode(document.jsonFields["path"], as: AGUI1JsonPointer.self) }
    public var value: AGUIJSON? { document.jsonFields["value"] }
    public func settingOp(_ value: String?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in .string(value) }
        return try Self(document: document.updating("op", to: next))
    }
    public func settingPath(_ value: AGUI1JsonPointer?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value.document.json }
        return try Self(document: document.updating("path", to: next))
    }
    public func settingValue(_ value: AGUIJSON?) throws -> Self {
        let next: AGUIJSON? = try value.map { value in value }
        return try Self(document: document.updating("value", to: next))
    }
    public init(path: AGUI1JsonPointer, value: AGUIJSON) throws {
        let values: [String: AGUIJSON] = [
            "op": .string("test"),
            "path": path.document.json,
            "value": value,
        ]
        self = try Self(try AGUIJSON.object(values).encoded())
    }
}

public struct AGUI1JsonPointer: AGUI1Definition {
    public static let definitionName = "JsonPointer"
    public let document: AGUISchemaDocument
    public init(document: AGUISchemaDocument) throws {
        guard document.definition == Self.definitionName else { throw AGUISchemaError.invalidValue(Self.definitionName) }
        self.document = document
    }
    public var value: String? { document.json.string }
}

public enum AGUI1Definitions {
    public static let all: [String: any AGUI1Definition.Type] = [
        "Event": AGUI1Event.self,
        "EventType": AGUI1EventType.self,
        "BaseEvent": AGUI1BaseEvent.self,
        "Attributable": AGUI1Attributable.self,
        "SubagentRunId": AGUI1SubagentRunId.self,
        "Metadata": AGUI1Metadata.self,
        "State": AGUI1State.self,
        "TextMessageRole": AGUI1TextMessageRole.self,
        "Role": AGUI1Role.self,
        "TextMessageStartEvent": AGUI1TextMessageStartEvent.self,
        "TextMessageContentEvent": AGUI1TextMessageContentEvent.self,
        "TextMessageEndEvent": AGUI1TextMessageEndEvent.self,
        "TextMessageChunkEvent": AGUI1TextMessageChunkEvent.self,
        "ToolCallStartEvent": AGUI1ToolCallStartEvent.self,
        "ToolCallArgsEvent": AGUI1ToolCallArgsEvent.self,
        "ToolCallEndEvent": AGUI1ToolCallEndEvent.self,
        "ToolCallChunkEvent": AGUI1ToolCallChunkEvent.self,
        "ToolCallResultEvent": AGUI1ToolCallResultEvent.self,
        "StateSnapshotEvent": AGUI1StateSnapshotEvent.self,
        "StateDeltaEvent": AGUI1StateDeltaEvent.self,
        "MessagesSnapshotEvent": AGUI1MessagesSnapshotEvent.self,
        "ActivitySnapshotEvent": AGUI1ActivitySnapshotEvent.self,
        "ActivityDeltaEvent": AGUI1ActivityDeltaEvent.self,
        "RawEvent": AGUI1RawEvent.self,
        "CustomEvent": AGUI1CustomEvent.self,
        "RunStartedEvent": AGUI1RunStartedEvent.self,
        "RunFinishedEvent": AGUI1RunFinishedEvent.self,
        "RunErrorEvent": AGUI1RunErrorEvent.self,
        "StepStartedEvent": AGUI1StepStartedEvent.self,
        "StepFinishedEvent": AGUI1StepFinishedEvent.self,
        "ReasoningStartEvent": AGUI1ReasoningStartEvent.self,
        "ReasoningMessageStartEvent": AGUI1ReasoningMessageStartEvent.self,
        "ReasoningMessageContentEvent": AGUI1ReasoningMessageContentEvent.self,
        "ReasoningMessageEndEvent": AGUI1ReasoningMessageEndEvent.self,
        "ReasoningMessageChunkEvent": AGUI1ReasoningMessageChunkEvent.self,
        "ReasoningEndEvent": AGUI1ReasoningEndEvent.self,
        "ReasoningEncryptedValueEvent": AGUI1ReasoningEncryptedValueEvent.self,
        "ReasoningEncryptedValueSubtype": AGUI1ReasoningEncryptedValueSubtype.self,
        "SubagentStartedEvent": AGUI1SubagentStartedEvent.self,
        "SubagentFinishedEvent": AGUI1SubagentFinishedEvent.self,
        "SubagentErrorEvent": AGUI1SubagentErrorEvent.self,
        "RunFinishedOutcome": AGUI1RunFinishedOutcome.self,
        "RunFinishedSuccessOutcome": AGUI1RunFinishedSuccessOutcome.self,
        "RunFinishedInterruptOutcome": AGUI1RunFinishedInterruptOutcome.self,
        "RunFinishedCancelledOutcome": AGUI1RunFinishedCancelledOutcome.self,
        "SubagentFinishedOutcome": AGUI1SubagentFinishedOutcome.self,
        "SubagentFinishedSuccessOutcome": AGUI1SubagentFinishedSuccessOutcome.self,
        "SubagentFinishedSuspendedOutcome": AGUI1SubagentFinishedSuspendedOutcome.self,
        "Interrupt": AGUI1Interrupt.self,
        "ResumeEntry": AGUI1ResumeEntry.self,
        "TokenUsage": AGUI1TokenUsage.self,
        "Message": AGUI1Message.self,
        "BaseMessage": AGUI1BaseMessage.self,
        "DeveloperMessage": AGUI1DeveloperMessage.self,
        "SystemMessage": AGUI1SystemMessage.self,
        "AssistantMessage": AGUI1AssistantMessage.self,
        "UserMessage": AGUI1UserMessage.self,
        "ToolMessage": AGUI1ToolMessage.self,
        "ActivityMessage": AGUI1ActivityMessage.self,
        "ReasoningMessage": AGUI1ReasoningMessage.self,
        "ToolCall": AGUI1ToolCall.self,
        "FunctionCall": AGUI1FunctionCall.self,
        "ContentPart": AGUI1ContentPart.self,
        "TextPart": AGUI1TextPart.self,
        "ImagePart": AGUI1ImagePart.self,
        "AudioPart": AGUI1AudioPart.self,
        "VideoPart": AGUI1VideoPart.self,
        "DocumentPart": AGUI1DocumentPart.self,
        "PartSource": AGUI1PartSource.self,
        "DataSource": AGUI1DataSource.self,
        "UrlSource": AGUI1UrlSource.self,
        "FileSource": AGUI1FileSource.self,
        "Context": AGUI1Context.self,
        "Tool": AGUI1Tool.self,
        "RunAgentInput": AGUI1RunAgentInput.self,
        "SubagentInfo": AGUI1SubagentInfo.self,
        "IdentityCapabilities": AGUI1IdentityCapabilities.self,
        "TransportCapabilities": AGUI1TransportCapabilities.self,
        "ToolsCapabilities": AGUI1ToolsCapabilities.self,
        "OutputCapabilities": AGUI1OutputCapabilities.self,
        "StateCapabilities": AGUI1StateCapabilities.self,
        "MultiAgentCapabilities": AGUI1MultiAgentCapabilities.self,
        "ReasoningCapabilities": AGUI1ReasoningCapabilities.self,
        "MultimodalInputCapabilities": AGUI1MultimodalInputCapabilities.self,
        "MultimodalOutputCapabilities": AGUI1MultimodalOutputCapabilities.self,
        "MultimodalCapabilities": AGUI1MultimodalCapabilities.self,
        "ExecutionCapabilities": AGUI1ExecutionCapabilities.self,
        "HumanInTheLoopCapabilities": AGUI1HumanInTheLoopCapabilities.self,
        "AgentCapabilities": AGUI1AgentCapabilities.self,
        "JsonPatch": AGUI1JsonPatch.self,
        "JsonPatchOperation": AGUI1JsonPatchOperation.self,
        "AddOperation": AGUI1AddOperation.self,
        "RemoveOperation": AGUI1RemoveOperation.self,
        "ReplaceOperation": AGUI1ReplaceOperation.self,
        "MoveOperation": AGUI1MoveOperation.self,
        "CopyOperation": AGUI1CopyOperation.self,
        "TestOperation": AGUI1TestOperation.self,
        "JsonPointer": AGUI1JsonPointer.self,
    ]
}
