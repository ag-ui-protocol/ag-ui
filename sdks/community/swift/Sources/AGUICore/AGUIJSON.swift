import Foundation

/// Lossless JSON tree. Number lexemes stay decimal text through nested edits.
public indirect enum AGUIJSON: Equatable, Sendable {
    case object([String: AGUIJSON])
    case array([AGUIJSON])
    case string(String)
    case number(String)
    case bool(Bool)
    case null

    public var object: [String: AGUIJSON]? { if case .object(let v) = self { v } else { nil } }
    public var array: [AGUIJSON]? { if case .array(let v) = self { v } else { nil } }
    public var string: String? { if case .string(let v) = self { v } else { nil } }
    public var number: String? { if case .number(let v) = self { v } else { nil } }
    /// Intended for schema fields bounded to the JSON safe-integer range.
    public var int64: Int64? {
        guard case .number(let v) = self else { return nil }
        return NSDecimalNumber(string: v).int64Value
    }
    public var bool: Bool? { if case .bool(let v) = self { v } else { nil } }

    public static func parse(_ data: Data) throws -> AGUIJSON {
        var parser = JSONParser(bytes: Array(data))
        let result = try parser.parseValue()
        parser.skipSpace()
        guard parser.index == parser.bytes.count else { throw AGUISchemaError.invalidJSON }
        return result
    }

    public func encoded() throws -> Data { Data(try render().utf8) }

    private func render() throws -> String {
        switch self {
        case .object(let fields):
            return "{" + (try fields.keys.sorted().map { key in
                try AGUIJSON.string(key).render() + ":" + fields[key]!.render()
            }).joined(separator: ",") + "}"
        case .array(let values): return "[" + (try values.map { try $0.render() }).joined(separator: ",") + "]"
        case .string(let value):
            return String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
        case .number(let lexeme):
            let pattern = #"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$"#
            guard lexeme.range(of: pattern, options: .regularExpression) != nil else {
                throw AGUISchemaError.invalidJSON
            }
            return lexeme
        case .bool(let value): return value ? "true" : "false"
        case .null: return "null"
        }
    }

    /// Converts ordinary Swift JSON values into the lossless tree. Use `.number` for
    /// integers outside Foundation's exact numeric range.
    public static func foundation(_ value: Any) throws -> AGUIJSON {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        return try parse(data)
    }
}

private struct JSONParser {
    let bytes: [UInt8]
    var index = 0

    mutating func skipSpace() {
        while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 }
    }

    mutating func parseValue() throws -> AGUIJSON {
        skipSpace()
        guard index < bytes.count else { throw AGUISchemaError.invalidJSON }
        switch bytes[index] {
        case 123:
            index += 1
            skipSpace()
            var fields: [String: AGUIJSON] = [:]
            if consume(125) { return .object(fields) }
            while true {
                guard case .string(let key) = try parseValue(), fields[key] == nil else { throw AGUISchemaError.invalidJSON }
                skipSpace()
                guard consume(58) else { throw AGUISchemaError.invalidJSON }
                fields[key] = try parseValue()
                skipSpace()
                if consume(125) { return .object(fields) }
                guard consume(44) else { throw AGUISchemaError.invalidJSON }
            }
        case 91:
            index += 1
            skipSpace()
            var values: [AGUIJSON] = []
            if consume(93) { return .array(values) }
            while true {
                values.append(try parseValue())
                skipSpace()
                if consume(93) { return .array(values) }
                guard consume(44) else { throw AGUISchemaError.invalidJSON }
            }
        case 34:
            let start = index
            index += 1
            var escaping = false
            while index < bytes.count {
                let byte = bytes[index]
                index += 1
                if byte == 34 && !escaping {
                    guard let value = try? JSONDecoder().decode(String.self, from: Data(bytes[start..<index])) else {
                        throw AGUISchemaError.invalidJSON
                    }
                    return .string(value)
                }
                if byte == 92 && !escaping { escaping = true } else { escaping = false }
            }
            throw AGUISchemaError.invalidJSON
        case 116: return try literal("true", .bool(true))
        case 102: return try literal("false", .bool(false))
        case 110: return try literal("null", .null)
        default:
            let start = index
            _ = consume(45)
            guard index < bytes.count else { throw AGUISchemaError.invalidJSON }
            if !consume(48) {
                guard digit(bytes[index], nonzero: true) else { throw AGUISchemaError.invalidJSON }
                while index < bytes.count && digit(bytes[index]) { index += 1 }
            }
            if consume(46) {
                guard index < bytes.count && digit(bytes[index]) else { throw AGUISchemaError.invalidJSON }
                while index < bytes.count && digit(bytes[index]) { index += 1 }
            }
            if consume(69) || consume(101) {
                if !consume(43) { _ = consume(45) }
                guard index < bytes.count && digit(bytes[index]) else { throw AGUISchemaError.invalidJSON }
                while index < bytes.count && digit(bytes[index]) { index += 1 }
            }
            return .number(String(decoding: bytes[start..<index], as: UTF8.self))
        }
    }

    private mutating func consume(_ byte: UInt8) -> Bool {
        guard index < bytes.count && bytes[index] == byte else { return false }
        index += 1
        return true
    }

    private mutating func literal(_ word: String, _ value: AGUIJSON) throws -> AGUIJSON {
        for byte in word.utf8 { guard consume(byte) else { throw AGUISchemaError.invalidJSON } }
        return value
    }

    private func digit(_ byte: UInt8, nonzero: Bool = false) -> Bool {
        byte >= (nonzero ? 49 : 48) && byte <= 57
    }
}
