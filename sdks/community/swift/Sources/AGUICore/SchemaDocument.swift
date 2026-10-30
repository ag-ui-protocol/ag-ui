import CoreFoundation
import Foundation

/// A document decoded against one named definition of the AG-UI 1.0 contract.
/// The original JSON tree is retained, including extension fields and opaque values.
public struct AGUISchemaDocument {
    public let definition: String
    public let json: AGUIJSON
    public var jsonFields: [String: AGUIJSON] { json.object ?? [:] }
    public let allowsUnknownFields: Bool

    public init(_ data: Data, definition: String = "Event", allowUnknownFields: Bool = false) throws {
        let json = try AGUIJSON.parse(data)
        guard let schema = Self.definitions[definition] else { throw AGUISchemaError.unknownDefinition(definition) }
        guard Self.accepts(json, schema: schema, allowUnknown: allowUnknownFields) else { throw AGUISchemaError.invalidValue(definition) }
        self.definition = definition
        self.json = json
        self.allowsUnknownFields = allowUnknownFields
    }

    /// Accepts producer objects with explicit optional nulls, applying the SDK's
    /// omission rule before strict schema validation.
    public init(normalizing data: Data, definition: String = "Event") throws {
        let input = try AGUIJSON.parse(data)
        guard let schema = Self.definitions[definition] else { throw AGUISchemaError.unknownDefinition(definition) }
        let normalized = Self.normalizeJSON(input, schema: schema)
        guard Self.acceptsJSON(normalized, schema: schema) else { throw AGUISchemaError.invalidValue(definition) }
        self.definition = definition
        self.json = normalized
        self.allowsUnknownFields = false
    }

    /// Projects future fields from closed schema objects before strict validation.
    /// Open objects (metadata, state, patch operations, and opaque values) stay intact.
    init(sanitizing data: Data, eventType: EventType) throws {
        let input = try AGUIJSON.parse(data)
        guard let event = Self.definitions["Event"],
              let variants = event["oneOf"] as? [[String: Any]],
              let variant = variants.first(where: { Self.eventType(of: $0) == eventType.rawValue }),
              let projected = Self.project(input, schema: variant) else {
            throw AGUISchemaError.invalidValue("Event")
        }
        try self.init(normalizing: projected.encoded())
    }

    /// The event map must remain exhaustive when the protocol adds a new event.
    static var sanitizableEventTypes: Set<EventType> {
        let variants = definitions["Event"]?["oneOf"] as? [[String: Any]] ?? []
        return Set(variants.compactMap { eventType(of: $0) }.compactMap(EventType.init(rawValue:)))
    }

    static func eventValidationIssue(_ data: Data, eventType: EventType) -> String? {
        guard let input = try? AGUIJSON.parse(data), case .object(let fields) = input,
              let variants = definitions["Event"]?["oneOf"] as? [[String: Any]],
              let variant = variants.first(where: { self.eventType(of: $0) == eventType.rawValue }),
              let schema = resolve(variant) else { return nil }
        var properties = schema["properties"] as? [String: [String: Any]] ?? [:]
        var required = Set(schema["required"] as? [String] ?? [])
        for part in schema["allOf"] as? [[String: Any]] ?? [] {
            guard let source = resolve(part) else { continue }
            properties.merge(source["properties"] as? [String: [String: Any]] ?? [:]) { current, _ in current }
            required.formUnion(source["required"] as? [String] ?? [])
        }
        for key in required.sorted() where fields[key] == nil { return "Missing key '\(key)'" }
        for key in fields.keys.sorted() {
            guard let value = fields[key], let property = properties[key],
                  !accepts(value, schema: property, allowUnknown: true) else { continue }
            if let constant = property["const"] as? String { return "expected \"\(constant)\" at \(key)" }
            if let expected = property["type"] as? String {
                if expected == "object", case .array = value { return "expected object, received array at \(key)" }
                return "Invalid \(expected) at \(key)"
            }
            return "Invalid value at \(key)"
        }
        return nil
    }

    public func encoded() throws -> Data {
        try json.encoded()
    }

    public func sseFrame() throws -> Data { Data("data: \(String(decoding: try json.encoded(), as: UTF8.self))\n\n".utf8) }

    public func updating(_ key: String, to newValue: AGUIJSON?) throws -> Self {
        guard case .object(var object) = json else { throw AGUISchemaError.invalidValue(definition) }
        object[key] = newValue
        return try Self(AGUIJSON.object(object).encoded(), definition: definition,
                        allowUnknownFields: allowsUnknownFields)
    }

    private static let definitions: [String: [String: Any]] = {
        let data = Data(schemaJSON.utf8)
        return try! JSONSerialization.jsonObject(with: data) as! [String: [String: Any]]
    }()

    private static func acceptsJSON(_ json: AGUIJSON, schema: [String: Any]) -> Bool {
        accepts(json, schema: schema)
    }

    private static func eventType(of variant: [String: Any]) -> String? {
        guard let ref = variant["$ref"] as? String,
              let definition = definitions[String(ref.split(separator: "/").last ?? "")],
              let properties = definition["properties"] as? [String: [String: Any]] else { return nil }
        return properties["type"]?["const"] as? String
    }

    /// A nil result is an unrecognised union member. Its parent removes it when optional
    /// or in a list; required positions retain it so validation reports the bad value.
    private static func project(_ value: AGUIJSON, schema: [String: Any]) -> AGUIJSON? {
        if let ref = schema["$ref"] as? String,
           let target = definitions[String(ref.split(separator: "/").last ?? "")] {
            return project(value, schema: target)
        }
        if let variants = schema["oneOf"] as? [[String: Any]] {
            if case .object(let fields) = value {
                let selected = variants.first { variant in
                    guard let resolved = resolve(variant),
                          let properties = resolved["properties"] as? [String: [String: Any]] else { return false }
                    return properties.contains { key, field in
                        guard let constant = field["const"], let supplied = fields[key] else { return false }
                        return matches(supplied, constant)
                    }
                }
                if let selected { return project(value, schema: selected) }
                // Only a well-typed unknown discriminator denotes a future member.
                // A number in a string discriminator is malformed and must reach validation.
                if variants.contains(where: { variant in
                    guard let properties = resolve(variant)?["properties"] as? [String: [String: Any]] else { return false }
                    return properties.contains { key, field in field["const"] != nil && fields[key] != nil }
                }), variants.contains(where: { variant in
                    guard let properties = resolve(variant)?["properties"] as? [String: [String: Any]] else { return false }
                    return properties.contains { key, field in
                        guard let constant = field["const"], let supplied = fields[key],
                              let expected = try? AGUIJSON.foundation(constant) else { return false }
                        switch (supplied, expected) {
                        case (.string, .string), (.number, .number), (.bool, .bool): return true
                        default: return false
                        }
                    }
                }) { return nil }
            }
            if let selected = variants.first(where: { variant in
                guard let type = resolve(variant)?["type"] as? String else { return false }
                switch (type, value) {
                case ("array", .array), ("string", .string), ("object", .object): return true
                default: return false
                }
            }) ?? variants.first(where: { accepts(value, schema: $0, allowUnknown: true) }) {
                return project(value, schema: selected)
            }
            return value
        }
        if case .array(let values) = value, let item = schema["items"] as? [String: Any] {
            return .array(values.compactMap { project($0, schema: item) })
        }
        guard case .object(let fields) = value else { return value }
        var properties = schema["properties"] as? [String: [String: Any]] ?? [:]
        var required = Set(schema["required"] as? [String] ?? [])
        for part in schema["allOf"] as? [[String: Any]] ?? [] {
            guard let resolved = resolve(part) else { continue }
            properties.merge(resolved["properties"] as? [String: [String: Any]] ?? [:]) { current, _ in current }
            required.formUnion(resolved["required"] as? [String] ?? [])
        }
        let closed = schema["unevaluatedProperties"] as? Bool == false || schema["additionalProperties"] as? Bool == false
        var result: [String: AGUIJSON] = [:]
        for (key, field) in fields {
            if let property = properties[key] {
                if let projected = project(field, schema: property) { result[key] = projected }
                else if required.contains(key) { return nil }
            } else if !closed {
                result[key] = field
            }
        }
        return .object(result)
    }

    private static func resolve(_ schema: [String: Any]) -> [String: Any]? {
        guard let ref = schema["$ref"] as? String else { return schema }
        return definitions[String(ref.split(separator: "/").last ?? "")]
    }

    private static func normalizeJSON(_ value: AGUIJSON, schema: [String: Any]) -> AGUIJSON {
        if let ref = schema["$ref"] as? String,
           let target = definitions[String(ref.split(separator: "/").last ?? "")] {
            return normalizeJSON(value, schema: target)
        }
        if let one = schema["oneOf"] as? [[String: Any]] {
            for variant in one {
                let candidate = normalizeJSON(value, schema: variant)
                if acceptsJSON(candidate, schema: variant) { return candidate }
            }
        }
        guard case .object(let object) = value else { return value }
        var properties = schema["properties"] as? [String: [String: Any]] ?? [:]
        var required = Set(schema["required"] as? [String] ?? [])
        for part in schema["allOf"] as? [[String: Any]] ?? [] {
            let source: [String: Any]
            if let ref = part["$ref"] as? String {
                source = definitions[String(ref.split(separator: "/").last ?? "")] ?? [:]
            } else { source = part }
            properties.merge(source["properties"] as? [String: [String: Any]] ?? [:]) { old, _ in old }
            required.formUnion(source["required"] as? [String] ?? [])
        }
        var result: [String: AGUIJSON] = [:]
        for (key, field) in object {
            if field == .null && properties[key] != nil && !required.contains(key) { continue }
            result[key] = properties[key].map { normalizeJSON(field, schema: $0) } ?? field
        }
        return .object(result)
    }

    private static func accepts(_ value: AGUIJSON, schema: [String: Any], allowUnknown: Bool = false) -> Bool {
        if let ref = schema["$ref"] as? String {
            let name = String(ref.split(separator: "/").last ?? "")
            guard let target = definitions[name], accepts(value, schema: target, allowUnknown: allowUnknown) else { return false }
        }
        if let constant = schema["const"], !matches(value, constant) { return false }
        if let choices = schema["enum"] as? [Any], !choices.contains(where: { matches(value, $0) }) { return false }
        if let all = schema["allOf"] as? [[String: Any]], !all.allSatisfy({ accepts(value, schema: $0, allowUnknown: allowUnknown) }) { return false }
        if let one = schema["oneOf"] as? [[String: Any]], one.filter({ accepts(value, schema: $0, allowUnknown: allowUnknown) }).count != 1 { return false }
        if let not = schema["not"] as? [String: Any], accepts(value, schema: not, allowUnknown: allowUnknown) { return false }
        if let type = schema["type"] as? String {
            switch (type, value) {
            case ("object", .object), ("array", .array), ("string", .string),
                 ("boolean", .bool), ("null", .null), ("number", .number): break
            case ("integer", .number(let lexeme)) where JSONDecimal(lexeme)?.isInteger == true: break
            default: return false
            }
        }
        if let pattern = schema["pattern"] as? String, case .string(let string) = value,
           string.range(of: pattern, options: .regularExpression) == nil { return false }
        if case .number(let lexeme) = value {
            guard let number = JSONDecimal(lexeme) else { return false }
            if let minimum = schema["minimum"] as? NSNumber,
               let bound = JSONDecimal(minimum.stringValue), number < bound { return false }
            if let maximum = schema["maximum"] as? NSNumber,
               let bound = JSONDecimal(maximum.stringValue), number > bound { return false }
        }
        if case .array(let values) = value {
            if let minimum = schema["minItems"] as? Int, values.count < minimum { return false }
            if let item = schema["items"] as? [String: Any], !values.allSatisfy({ accepts($0, schema: item, allowUnknown: allowUnknown) }) { return false }
        }
        if case .object(let fields) = value {
            for key in schema["required"] as? [String] ?? [] where fields[key] == nil { return false }
            let properties = schema["properties"] as? [String: [String: Any]] ?? [:]
            for (key, item) in fields {
                if let property = properties[key] {
                    if !accepts(item, schema: property, allowUnknown: allowUnknown) { return false }
                } else if let additional = schema["additionalProperties"] as? Bool, !additional && !allowUnknown {
                    return false
                } else if let additional = schema["additionalProperties"] as? [String: Any] {
                    if !accepts(item, schema: additional, allowUnknown: allowUnknown) { return false }
                } else if !allowUnknown && schema["unevaluatedProperties"] as? Bool == false && !knownKeys(schema).contains(key) {
                    return false
                }
            }
        }
        return true
    }

    private static func matches(_ value: AGUIJSON, _ schemaValue: Any) -> Bool {
        guard let expected = try? AGUIJSON.foundation(schemaValue) else { return false }
        if case .number(let a) = value, case .number(let b) = expected {
            return JSONDecimal(a) == JSONDecimal(b)
        }
        return value == expected
    }

    private static func knownKeys(_ schema: [String: Any]) -> Set<String> {
        var keys = Set((schema["properties"] as? [String: Any] ?? [:]).keys)
        for part in schema["allOf"] as? [[String: Any]] ?? [] {
            keys.formUnion(knownKeys(part))
            if let ref = part["$ref"] as? String,
               let target = definitions[String(ref.split(separator: "/").last ?? "")] { keys.formUnion(knownKeys(target)) }
        }
        return keys
    }
}

public enum AGUISchemaError: Error { case invalidJSON, unknownDefinition(String), invalidValue(String) }

/// Exact base-10 comparison for schema integer and range checks. The coefficient
/// is normalized without converting the JSON number through floating point.
private struct JSONDecimal: Comparable {
    let sign: Int
    let digits: [UInt8]
    let exponent: Int

    init?(_ lexeme: String) {
        let parts = lexeme.lowercased().split(separator: "e", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return nil }
        let significand = String(parts[0])
        let negative = significand.hasPrefix("-")
        let unsigned = negative ? String(significand.dropFirst()) : significand
        let decimal = unsigned.split(separator: ".", omittingEmptySubsequences: false)
        guard decimal.count <= 2 else { return nil }
        let fractionalCount = decimal.count == 2 ? decimal[1].count : 0
        var coefficient = Array(decimal.joined().utf8)
        while coefficient.first == 48 { coefficient.removeFirst() }
        if coefficient.isEmpty {
            sign = 0; digits = []; exponent = 0
            return
        }
        var power = -fractionalCount
        if parts.count == 2 {
            let raw = String(parts[1])
            let negativeExponent = raw.hasPrefix("-")
            let magnitude = raw.hasPrefix("-") || raw.hasPrefix("+") ? String(raw.dropFirst()) : raw
            let parsed = Int(magnitude) ?? 1_000_000_000
            power += negativeExponent ? -min(parsed, 1_000_000_000) : min(parsed, 1_000_000_000)
        }
        while coefficient.last == 48 {
            coefficient.removeLast()
            power += 1
        }
        sign = negative ? -1 : 1
        digits = coefficient
        exponent = power
    }

    var isInteger: Bool { sign == 0 || exponent >= 0 }

    static func == (left: Self, right: Self) -> Bool { compare(left, right) == 0 }
    static func < (left: Self, right: Self) -> Bool { compare(left, right) < 0 }

    private static func compare(_ left: Self, _ right: Self) -> Int {
        if left.sign != right.sign { return left.sign < right.sign ? -1 : 1 }
        if left.sign == 0 { return 0 }
        let leftOrder = left.digits.count + left.exponent
        let rightOrder = right.digits.count + right.exponent
        if leftOrder != rightOrder {
            let result = leftOrder < rightOrder ? -1 : 1
            return left.sign * result
        }
        for index in 0..<max(left.digits.count, right.digits.count) {
            let a = index < left.digits.count ? left.digits[index] : 48
            let b = index < right.digits.count ? right.digits[index] : 48
            if a != b { return left.sign * (a < b ? -1 : 1) }
        }
        return 0
    }
}

private let schemaJSON = #"""
{"Event":{"oneOf":[{"$ref":"#/$defs/TextMessageStartEvent"},{"$ref":"#/$defs/TextMessageContentEvent"},{"$ref":"#/$defs/TextMessageEndEvent"},{"$ref":"#/$defs/TextMessageChunkEvent"},{"$ref":"#/$defs/ToolCallStartEvent"},{"$ref":"#/$defs/ToolCallArgsEvent"},{"$ref":"#/$defs/ToolCallEndEvent"},{"$ref":"#/$defs/ToolCallChunkEvent"},{"$ref":"#/$defs/ToolCallResultEvent"},{"$ref":"#/$defs/StateSnapshotEvent"},{"$ref":"#/$defs/StateDeltaEvent"},{"$ref":"#/$defs/MessagesSnapshotEvent"},{"$ref":"#/$defs/ActivitySnapshotEvent"},{"$ref":"#/$defs/ActivityDeltaEvent"},{"$ref":"#/$defs/RawEvent"},{"$ref":"#/$defs/CustomEvent"},{"$ref":"#/$defs/RunStartedEvent"},{"$ref":"#/$defs/RunFinishedEvent"},{"$ref":"#/$defs/RunErrorEvent"},{"$ref":"#/$defs/StepStartedEvent"},{"$ref":"#/$defs/StepFinishedEvent"},{"$ref":"#/$defs/ReasoningStartEvent"},{"$ref":"#/$defs/ReasoningMessageStartEvent"},{"$ref":"#/$defs/ReasoningMessageContentEvent"},{"$ref":"#/$defs/ReasoningMessageEndEvent"},{"$ref":"#/$defs/ReasoningMessageChunkEvent"},{"$ref":"#/$defs/ReasoningEndEvent"},{"$ref":"#/$defs/ReasoningEncryptedValueEvent"},{"$ref":"#/$defs/SubagentStartedEvent"},{"$ref":"#/$defs/SubagentFinishedEvent"},{"$ref":"#/$defs/SubagentErrorEvent"}]},"EventType":{"type":"string","enum":["TEXT_MESSAGE_START","TEXT_MESSAGE_CONTENT","TEXT_MESSAGE_END","TEXT_MESSAGE_CHUNK","TOOL_CALL_START","TOOL_CALL_ARGS","TOOL_CALL_END","TOOL_CALL_CHUNK","TOOL_CALL_RESULT","STATE_SNAPSHOT","STATE_DELTA","MESSAGES_SNAPSHOT","ACTIVITY_SNAPSHOT","ACTIVITY_DELTA","RAW","CUSTOM","RUN_STARTED","RUN_FINISHED","RUN_ERROR","STEP_STARTED","STEP_FINISHED","REASONING_START","REASONING_MESSAGE_START","REASONING_MESSAGE_CONTENT","REASONING_MESSAGE_END","REASONING_MESSAGE_CHUNK","REASONING_END","REASONING_ENCRYPTED_VALUE","SUBAGENT_STARTED","SUBAGENT_FINISHED","SUBAGENT_ERROR"]},"BaseEvent":{"type":"object","properties":{"type":{"$ref":"#/$defs/EventType"},"timestamp":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"rawEvent":{"not":{"type":"null"}},"metadata":{"$ref":"#/$defs/Metadata"}},"required":["type"]},"Attributable":{"type":"object","properties":{"subagentRunId":{"$ref":"#/$defs/SubagentRunId"}}},"SubagentRunId":{"type":"string"},"Metadata":{"type":"object","additionalProperties":true},"State":{},"TextMessageRole":{"type":"string","enum":["developer","system","assistant","user"]},"Role":{"type":"string","enum":["developer","system","assistant","user","tool","activity","reasoning"]},"TextMessageStartEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"TEXT_MESSAGE_START"},"messageId":{"type":"string"},"role":{"$ref":"#/$defs/TextMessageRole"},"name":{"type":"string"}},"required":["type","messageId"],"unevaluatedProperties":false},"TextMessageContentEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"TEXT_MESSAGE_CONTENT"},"messageId":{"type":"string"},"delta":{"type":"string"}},"required":["type","messageId","delta"],"unevaluatedProperties":false},"TextMessageEndEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"TEXT_MESSAGE_END"},"messageId":{"type":"string"}},"required":["type","messageId"],"unevaluatedProperties":false},"TextMessageChunkEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"TEXT_MESSAGE_CHUNK"},"messageId":{"type":"string"},"role":{"$ref":"#/$defs/TextMessageRole"},"delta":{"type":"string"},"name":{"type":"string"}},"required":["type"],"unevaluatedProperties":false},"ToolCallStartEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"TOOL_CALL_START"},"toolCallId":{"type":"string"},"toolCallName":{"type":"string"},"parentMessageId":{"type":"string"}},"required":["type","toolCallId","toolCallName"],"unevaluatedProperties":false},"ToolCallArgsEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"TOOL_CALL_ARGS"},"toolCallId":{"type":"string"},"delta":{"type":"string"}},"required":["type","toolCallId","delta"],"unevaluatedProperties":false},"ToolCallEndEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"TOOL_CALL_END"},"toolCallId":{"type":"string"}},"required":["type","toolCallId"],"unevaluatedProperties":false},"ToolCallChunkEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"TOOL_CALL_CHUNK"},"toolCallId":{"type":"string"},"toolCallName":{"type":"string"},"parentMessageId":{"type":"string"},"delta":{"type":"string"}},"required":["type"],"unevaluatedProperties":false},"ToolCallResultEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"TOOL_CALL_RESULT"},"messageId":{"type":"string"},"toolCallId":{"type":"string"},"content":{"oneOf":[{"type":"string"},{"type":"array","items":{"$ref":"#/$defs/ContentPart"}}]},"role":{"const":"tool"}},"required":["type","messageId","toolCallId","content"],"unevaluatedProperties":false},"StateSnapshotEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"STATE_SNAPSHOT"},"snapshot":{"$ref":"#/$defs/State"}},"required":["type","snapshot"],"unevaluatedProperties":false},"StateDeltaEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"STATE_DELTA"},"delta":{"$ref":"#/$defs/JsonPatch"}},"required":["type","delta"],"unevaluatedProperties":false},"MessagesSnapshotEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"}],"properties":{"type":{"const":"MESSAGES_SNAPSHOT"},"messages":{"type":"array","items":{"$ref":"#/$defs/Message"}}},"required":["type","messages"],"unevaluatedProperties":false},"ActivitySnapshotEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"ACTIVITY_SNAPSHOT"},"messageId":{"type":"string"},"activityType":{"type":"string"},"content":{"type":"object","additionalProperties":true},"replace":{"type":"boolean"}},"required":["type","messageId","activityType","content"],"unevaluatedProperties":false},"ActivityDeltaEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"ACTIVITY_DELTA"},"messageId":{"type":"string"},"activityType":{"type":"string"},"patch":{"$ref":"#/$defs/JsonPatch"}},"required":["type","messageId","activityType","patch"],"unevaluatedProperties":false},"RawEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"RAW"},"event":{},"source":{"type":"string"}},"required":["type","event"],"unevaluatedProperties":false},"CustomEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"CUSTOM"},"name":{"type":"string"},"value":{}},"required":["type","name","value"],"unevaluatedProperties":false},"RunStartedEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"}],"properties":{"type":{"const":"RUN_STARTED"},"threadId":{"type":"string"},"runId":{"type":"string"},"protocolVersion":{"type":"string"},"parentRunId":{"type":"string"},"input":{"$ref":"#/$defs/RunAgentInput"}},"required":["type","threadId","runId"],"unevaluatedProperties":false},"RunFinishedEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"}],"properties":{"type":{"const":"RUN_FINISHED"},"threadId":{"type":"string"},"runId":{"type":"string"},"result":{"not":{"type":"null"}},"outcome":{"$ref":"#/$defs/RunFinishedOutcome"},"usage":{"type":"array","items":{"$ref":"#/$defs/TokenUsage"}}},"required":["type","threadId","runId"],"unevaluatedProperties":false},"RunErrorEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"}],"properties":{"type":{"const":"RUN_ERROR"},"message":{"type":"string"},"code":{"type":"string"},"usage":{"type":"array","items":{"$ref":"#/$defs/TokenUsage"}}},"required":["type","message"],"unevaluatedProperties":false},"StepStartedEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"STEP_STARTED"},"stepName":{"type":"string"}},"required":["type","stepName"],"unevaluatedProperties":false},"StepFinishedEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"STEP_FINISHED"},"stepName":{"type":"string"}},"required":["type","stepName"],"unevaluatedProperties":false},"ReasoningStartEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"REASONING_START"},"messageId":{"type":"string"}},"required":["type","messageId"],"unevaluatedProperties":false},"ReasoningMessageStartEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"REASONING_MESSAGE_START"},"messageId":{"type":"string"},"role":{"const":"reasoning"}},"required":["type","messageId","role"],"unevaluatedProperties":false},"ReasoningMessageContentEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"REASONING_MESSAGE_CONTENT"},"messageId":{"type":"string"},"delta":{"type":"string"}},"required":["type","messageId","delta"],"unevaluatedProperties":false},"ReasoningMessageEndEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"REASONING_MESSAGE_END"},"messageId":{"type":"string"}},"required":["type","messageId"],"unevaluatedProperties":false},"ReasoningMessageChunkEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"REASONING_MESSAGE_CHUNK"},"messageId":{"type":"string"},"delta":{"type":"string"}},"required":["type"],"unevaluatedProperties":false},"ReasoningEndEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"REASONING_END"},"messageId":{"type":"string"}},"required":["type","messageId"],"unevaluatedProperties":false},"ReasoningEncryptedValueEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"},{"$ref":"#/$defs/Attributable"}],"properties":{"type":{"const":"REASONING_ENCRYPTED_VALUE"},"subtype":{"$ref":"#/$defs/ReasoningEncryptedValueSubtype"},"entityId":{"type":"string"},"encryptedValue":{"type":"string"}},"required":["type","subtype","entityId","encryptedValue"],"unevaluatedProperties":false},"ReasoningEncryptedValueSubtype":{"type":"string","enum":["tool-call","message"]},"SubagentStartedEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"}],"properties":{"type":{"const":"SUBAGENT_STARTED"},"subagentRunId":{"$ref":"#/$defs/SubagentRunId"},"name":{"type":"string"},"description":{"type":"string"},"parentSubagentRunId":{"$ref":"#/$defs/SubagentRunId"},"parentToolCallId":{"type":"string"},"parentMessageId":{"type":"string"}},"required":["type","subagentRunId","name"],"unevaluatedProperties":false},"SubagentFinishedEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"}],"properties":{"type":{"const":"SUBAGENT_FINISHED"},"subagentRunId":{"$ref":"#/$defs/SubagentRunId"},"result":{"not":{"type":"null"}},"outcome":{"$ref":"#/$defs/SubagentFinishedOutcome"}},"required":["type","subagentRunId"],"unevaluatedProperties":false},"SubagentErrorEvent":{"type":"object","allOf":[{"$ref":"#/$defs/BaseEvent"}],"properties":{"type":{"const":"SUBAGENT_ERROR"},"subagentRunId":{"$ref":"#/$defs/SubagentRunId"},"message":{"type":"string"},"code":{"type":"string"}},"required":["type","subagentRunId","message"],"unevaluatedProperties":false},"RunFinishedOutcome":{"oneOf":[{"$ref":"#/$defs/RunFinishedSuccessOutcome"},{"$ref":"#/$defs/RunFinishedInterruptOutcome"},{"$ref":"#/$defs/RunFinishedCancelledOutcome"}]},"RunFinishedSuccessOutcome":{"type":"object","properties":{"type":{"const":"success"},"pendingToolCallIds":{"type":"array","items":{"type":"string"}}},"required":["type"],"unevaluatedProperties":false},"RunFinishedInterruptOutcome":{"type":"object","properties":{"type":{"const":"interrupt"},"interrupts":{"type":"array","minItems":1,"items":{"$ref":"#/$defs/Interrupt"}}},"required":["type","interrupts"],"unevaluatedProperties":false},"RunFinishedCancelledOutcome":{"type":"object","properties":{"type":{"const":"cancelled"}},"required":["type"],"unevaluatedProperties":false},"SubagentFinishedOutcome":{"oneOf":[{"$ref":"#/$defs/SubagentFinishedSuccessOutcome"},{"$ref":"#/$defs/SubagentFinishedSuspendedOutcome"}]},"SubagentFinishedSuccessOutcome":{"type":"object","properties":{"type":{"const":"success"}},"required":["type"],"unevaluatedProperties":false},"SubagentFinishedSuspendedOutcome":{"type":"object","properties":{"type":{"const":"suspended"},"interruptIds":{"type":"array","items":{"type":"string"}}},"required":["type"],"unevaluatedProperties":false},"Interrupt":{"type":"object","allOf":[{"$ref":"#/$defs/Attributable"}],"properties":{"id":{"type":"string"},"reason":{"type":"string"},"message":{"type":"string"},"toolCallId":{"type":"string"},"responseSchema":{"type":"object","additionalProperties":true},"expiresAt":{"type":"string"},"metadata":{"$ref":"#/$defs/Metadata"}},"required":["id","reason"],"unevaluatedProperties":false},"ResumeEntry":{"type":"object","properties":{"interruptId":{"type":"string"},"status":{"type":"string","enum":["resolved","cancelled"]},"payload":{"not":{"type":"null"}},"metadata":{"$ref":"#/$defs/Metadata"}},"required":["interruptId","status"],"unevaluatedProperties":false},"TokenUsage":{"type":"object","properties":{"provider":{"type":"string"},"model":{"type":"string"},"inputTokens":{"type":"integer","minimum":0,"maximum":9007199254740991},"outputTokens":{"type":"integer","minimum":0,"maximum":9007199254740991},"totalTokens":{"type":"integer","minimum":0,"maximum":9007199254740991},"reasoningTokens":{"type":"integer","minimum":0,"maximum":9007199254740991},"cachedInputTokens":{"type":"integer","minimum":0,"maximum":9007199254740991},"cacheWriteInputTokens":{"type":"integer","minimum":0,"maximum":9007199254740991}},"unevaluatedProperties":false},"Message":{"oneOf":[{"$ref":"#/$defs/DeveloperMessage"},{"$ref":"#/$defs/SystemMessage"},{"$ref":"#/$defs/AssistantMessage"},{"$ref":"#/$defs/UserMessage"},{"$ref":"#/$defs/ToolMessage"},{"$ref":"#/$defs/ActivityMessage"},{"$ref":"#/$defs/ReasoningMessage"}]},"BaseMessage":{"type":"object","allOf":[{"$ref":"#/$defs/Attributable"}],"properties":{"id":{"type":"string"},"role":{"type":"string"},"name":{"type":"string"},"encryptedValue":{"type":"string"},"metadata":{"$ref":"#/$defs/Metadata"}},"required":["id","role"]},"DeveloperMessage":{"type":"object","allOf":[{"$ref":"#/$defs/BaseMessage"}],"properties":{"role":{"const":"developer"},"content":{"type":"string"}},"required":["id","role","content"],"unevaluatedProperties":false},"SystemMessage":{"type":"object","allOf":[{"$ref":"#/$defs/BaseMessage"}],"properties":{"role":{"const":"system"},"content":{"type":"string"}},"required":["id","role","content"],"unevaluatedProperties":false},"AssistantMessage":{"type":"object","allOf":[{"$ref":"#/$defs/BaseMessage"}],"properties":{"role":{"const":"assistant"},"content":{"type":"string"},"toolCalls":{"type":"array","items":{"$ref":"#/$defs/ToolCall"}}},"required":["id","role"],"unevaluatedProperties":false},"UserMessage":{"type":"object","allOf":[{"$ref":"#/$defs/BaseMessage"}],"properties":{"role":{"const":"user"},"content":{"oneOf":[{"type":"string"},{"type":"array","items":{"$ref":"#/$defs/ContentPart"}}]}},"required":["id","role","content"],"unevaluatedProperties":false},"ToolMessage":{"type":"object","allOf":[{"$ref":"#/$defs/Attributable"}],"properties":{"id":{"type":"string"},"role":{"const":"tool"},"content":{"oneOf":[{"type":"string"},{"type":"array","items":{"$ref":"#/$defs/ContentPart"}}]},"toolCallId":{"type":"string"},"error":{"type":"string"},"encryptedValue":{"type":"string"},"metadata":{"$ref":"#/$defs/Metadata"}},"required":["id","role","content","toolCallId"],"unevaluatedProperties":false},"ActivityMessage":{"type":"object","allOf":[{"$ref":"#/$defs/Attributable"}],"properties":{"id":{"type":"string"},"role":{"const":"activity"},"activityType":{"type":"string"},"content":{"type":"object","additionalProperties":true},"metadata":{"$ref":"#/$defs/Metadata"}},"required":["id","role","activityType","content"],"unevaluatedProperties":false},"ReasoningMessage":{"type":"object","allOf":[{"$ref":"#/$defs/Attributable"}],"properties":{"id":{"type":"string"},"role":{"const":"reasoning"},"content":{"type":"string"},"encryptedValue":{"type":"string"},"metadata":{"$ref":"#/$defs/Metadata"}},"required":["id","role","content"],"unevaluatedProperties":false},"ToolCall":{"type":"object","properties":{"id":{"type":"string"},"type":{"const":"function"},"function":{"$ref":"#/$defs/FunctionCall"},"encryptedValue":{"type":"string"},"metadata":{"$ref":"#/$defs/Metadata"}},"required":["id","type","function"],"unevaluatedProperties":false},"FunctionCall":{"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"string"}},"required":["name","arguments"],"unevaluatedProperties":false},"ContentPart":{"oneOf":[{"$ref":"#/$defs/TextPart"},{"$ref":"#/$defs/ImagePart"},{"$ref":"#/$defs/AudioPart"},{"$ref":"#/$defs/VideoPart"},{"$ref":"#/$defs/DocumentPart"}]},"TextPart":{"type":"object","properties":{"type":{"const":"text"},"id":{"type":"string"},"text":{"type":"string"},"metadata":{"not":{"type":"null"}}},"required":["type","text"],"unevaluatedProperties":false},"ImagePart":{"type":"object","properties":{"type":{"const":"image"},"id":{"type":"string"},"source":{"$ref":"#/$defs/PartSource"},"metadata":{"not":{"type":"null"}}},"required":["type","source"],"unevaluatedProperties":false},"AudioPart":{"type":"object","properties":{"type":{"const":"audio"},"id":{"type":"string"},"source":{"$ref":"#/$defs/PartSource"},"metadata":{"not":{"type":"null"}}},"required":["type","source"],"unevaluatedProperties":false},"VideoPart":{"type":"object","properties":{"type":{"const":"video"},"id":{"type":"string"},"source":{"$ref":"#/$defs/PartSource"},"metadata":{"not":{"type":"null"}}},"required":["type","source"],"unevaluatedProperties":false},"DocumentPart":{"type":"object","properties":{"type":{"const":"document"},"id":{"type":"string"},"source":{"$ref":"#/$defs/PartSource"},"metadata":{"not":{"type":"null"}}},"required":["type","source"],"unevaluatedProperties":false},"PartSource":{"oneOf":[{"$ref":"#/$defs/DataSource"},{"$ref":"#/$defs/UrlSource"},{"$ref":"#/$defs/FileSource"}]},"DataSource":{"type":"object","properties":{"type":{"const":"data"},"value":{"type":"string","contentEncoding":"base64"},"mimeType":{"type":"string"}},"required":["type","value","mimeType"],"unevaluatedProperties":false},"UrlSource":{"type":"object","properties":{"type":{"const":"url"},"value":{"type":"string"},"mimeType":{"type":"string"}},"required":["type","value"],"unevaluatedProperties":false},"FileSource":{"type":"object","properties":{"type":{"const":"file"},"value":{"type":"string"},"provider":{"type":"string"},"mimeType":{"type":"string"}},"required":["type","value"],"unevaluatedProperties":false},"Context":{"type":"object","properties":{"description":{"type":"string"},"value":{"type":"string"}},"required":["description","value"],"unevaluatedProperties":false},"Tool":{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"parameters":{"not":{"type":"null"}},"metadata":{"$ref":"#/$defs/Metadata"}},"required":["name","description"],"unevaluatedProperties":false},"RunAgentInput":{"type":"object","properties":{"threadId":{"type":"string"},"runId":{"type":"string"},"protocolVersion":{"type":"string"},"parentRunId":{"type":"string"},"state":{"not":{"type":"null"},"$ref":"#/$defs/State"},"messages":{"type":"array","items":{"$ref":"#/$defs/Message"}},"tools":{"type":"array","items":{"$ref":"#/$defs/Tool"}},"context":{"type":"array","items":{"$ref":"#/$defs/Context"}},"forwardedProps":{"not":{"type":"null"}},"resume":{"type":"array","items":{"$ref":"#/$defs/ResumeEntry"}}},"required":["threadId","runId","messages"],"unevaluatedProperties":false},"SubagentInfo":{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"}},"required":["name"],"unevaluatedProperties":false},"IdentityCapabilities":{"type":"object","properties":{"name":{"type":"string"},"type":{"type":"string"},"description":{"type":"string"},"version":{"type":"string"},"provider":{"type":"string"},"documentationUrl":{"type":"string"},"metadata":{"$ref":"#/$defs/Metadata"}},"unevaluatedProperties":false},"TransportCapabilities":{"type":"object","properties":{"streaming":{"type":"boolean"},"websocket":{"type":"boolean"},"httpBinary":{"type":"boolean"},"pushNotifications":{"type":"boolean"},"resumable":{"type":"boolean"}},"unevaluatedProperties":false},"ToolsCapabilities":{"type":"object","properties":{"supported":{"type":"boolean"},"items":{"type":"array","items":{"$ref":"#/$defs/Tool"}},"parallelCalls":{"type":"boolean"},"clientProvided":{"type":"boolean"}},"unevaluatedProperties":false},"OutputCapabilities":{"type":"object","properties":{"structuredOutput":{"type":"boolean"},"supportedMimeTypes":{"type":"array","items":{"type":"string"}}},"unevaluatedProperties":false},"StateCapabilities":{"type":"object","properties":{"snapshots":{"type":"boolean"},"deltas":{"type":"boolean"},"memory":{"type":"boolean"},"persistentState":{"type":"boolean"}},"unevaluatedProperties":false},"MultiAgentCapabilities":{"type":"object","properties":{"supported":{"type":"boolean"},"delegation":{"type":"boolean"},"handoffs":{"type":"boolean"},"subagents":{"type":"array","items":{"$ref":"#/$defs/SubagentInfo"}}},"unevaluatedProperties":false},"ReasoningCapabilities":{"type":"object","properties":{"supported":{"type":"boolean"},"streaming":{"type":"boolean"},"encrypted":{"type":"boolean"}},"unevaluatedProperties":false},"MultimodalInputCapabilities":{"type":"object","properties":{"image":{"type":"boolean"},"audio":{"type":"boolean"},"video":{"type":"boolean"},"pdf":{"type":"boolean"},"file":{"type":"boolean"}},"unevaluatedProperties":false},"MultimodalOutputCapabilities":{"type":"object","properties":{"image":{"type":"boolean"},"audio":{"type":"boolean"}},"unevaluatedProperties":false},"MultimodalCapabilities":{"type":"object","properties":{"input":{"$ref":"#/$defs/MultimodalInputCapabilities"},"output":{"$ref":"#/$defs/MultimodalOutputCapabilities"}},"unevaluatedProperties":false},"ExecutionCapabilities":{"type":"object","properties":{"codeExecution":{"type":"boolean"},"sandboxed":{"type":"boolean"},"maxIterations":{"type":"integer","minimum":0,"maximum":9007199254740991},"maxExecutionTime":{"type":"integer","minimum":0,"maximum":9007199254740991}},"unevaluatedProperties":false},"HumanInTheLoopCapabilities":{"type":"object","properties":{"supported":{"type":"boolean"},"approvals":{"type":"boolean"},"interventions":{"type":"boolean"},"feedback":{"type":"boolean"},"interrupts":{"type":"boolean"},"approveWithEdits":{"type":"boolean"}},"unevaluatedProperties":false},"AgentCapabilities":{"type":"object","properties":{"identity":{"$ref":"#/$defs/IdentityCapabilities"},"transport":{"$ref":"#/$defs/TransportCapabilities"},"tools":{"$ref":"#/$defs/ToolsCapabilities"},"output":{"$ref":"#/$defs/OutputCapabilities"},"state":{"$ref":"#/$defs/StateCapabilities"},"multiAgent":{"$ref":"#/$defs/MultiAgentCapabilities"},"reasoning":{"$ref":"#/$defs/ReasoningCapabilities"},"multimodal":{"$ref":"#/$defs/MultimodalCapabilities"},"execution":{"$ref":"#/$defs/ExecutionCapabilities"},"humanInTheLoop":{"$ref":"#/$defs/HumanInTheLoopCapabilities"},"custom":{"type":"object","additionalProperties":true}},"unevaluatedProperties":false},"JsonPatch":{"type":"array","items":{"$ref":"#/$defs/JsonPatchOperation"}},"JsonPatchOperation":{"oneOf":[{"$ref":"#/$defs/AddOperation"},{"$ref":"#/$defs/RemoveOperation"},{"$ref":"#/$defs/ReplaceOperation"},{"$ref":"#/$defs/MoveOperation"},{"$ref":"#/$defs/CopyOperation"},{"$ref":"#/$defs/TestOperation"}]},"AddOperation":{"type":"object","properties":{"op":{"const":"add"},"path":{"$ref":"#/$defs/JsonPointer"},"value":{}},"required":["op","path","value"]},"RemoveOperation":{"type":"object","properties":{"op":{"const":"remove"},"path":{"$ref":"#/$defs/JsonPointer"}},"required":["op","path"]},"ReplaceOperation":{"type":"object","properties":{"op":{"const":"replace"},"path":{"$ref":"#/$defs/JsonPointer"},"value":{}},"required":["op","path","value"]},"MoveOperation":{"type":"object","properties":{"op":{"const":"move"},"from":{"$ref":"#/$defs/JsonPointer"},"path":{"$ref":"#/$defs/JsonPointer"}},"required":["op","from","path"]},"CopyOperation":{"type":"object","properties":{"op":{"const":"copy"},"from":{"$ref":"#/$defs/JsonPointer"},"path":{"$ref":"#/$defs/JsonPointer"}},"required":["op","from","path"]},"TestOperation":{"type":"object","properties":{"op":{"const":"test"},"path":{"$ref":"#/$defs/JsonPointer"},"value":{}},"required":["op","path","value"]},"JsonPointer":{"type":"string","pattern":"^(/([^/~]|~[01])*)*$"}}
"""#
