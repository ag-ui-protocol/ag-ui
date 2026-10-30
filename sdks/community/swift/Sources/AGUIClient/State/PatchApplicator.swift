import AGUICore
import Foundation

/// RFC 6902 edits over lossless JSON, preserving large integer lexemes.
public struct PatchApplicator: Sendable {
    public enum PatchError: Error, LocalizedError {
        case invalidJSON(String), invalidPatch(String), invalidOperation(String), pathNotFound(String), testFailed(String)
        public var errorDescription: String? {
            switch self {
            case .invalidJSON(let s): return "Invalid JSON: \(s)"
            case .invalidPatch(let s): return "Invalid patch: \(s)"
            case .invalidOperation(let s): return "Invalid operation: \(s)"
            case .pathNotFound(let s): return "Path not found: \(s)"
            case .testFailed(let s): return "Test failed: \(s)"
            }
        }
    }
    public init() {}

    public func apply(patch: Data, to state: Data) throws -> Data {
        let parsed: AGUIJSON
        do { parsed = try AGUIJSON.parse(state) }
        catch { throw PatchError.invalidJSON("Unable to parse state") }
        let operations: [AGUIJSON]
        do {
            guard let array = try AGUIJSON.parse(patch).array else { throw PatchError.invalidPatch("Expected array") }
            operations = array
        } catch { throw PatchError.invalidPatch("Unable to parse patch: \(error)") }
        var document = parsed
        for (index, entry) in operations.enumerated() {
            guard let fields = entry.object, let op = fields["op"]?.string, let path = fields["path"]?.string
            else { throw PatchError.invalidPatch("Malformed operation") }
            guard ["add", "remove", "replace", "move", "copy", "test"].contains(op) else {
                FileHandle.standardError.write(Data("Dropped unknown patch operation at /delta/\(index)\n".utf8))
                continue
            }
            let tokens = try pointer(path)
            switch op {
            case "add", "replace":
                guard let value = fields["value"] else { throw PatchError.invalidOperation("\(op) missing value") }
                document = try edit(document, tokens, value, op == "add" ? .add : .replace)
            case "remove": document = try edit(document, tokens, nil, .remove)
            case "move", "copy":
                guard let from = fields["from"]?.string else { throw PatchError.invalidOperation("\(op) missing from") }
                let source = try pointer(from)
                let value = try get(document, source)
                if op == "move" { document = try edit(document, source, nil, .remove) }
                document = try edit(document, tokens, value, .add)
            case "test":
                guard let value = fields["value"] else { throw PatchError.invalidOperation("test missing value") }
                guard try equal(get(document, tokens), value) else { throw PatchError.testFailed(path) }
            default: break
            }
        }
        return try document.encoded()
    }
    private enum Edit { case add, remove, replace }
    private func pointer(_ path: String) throws -> [String] {
        if path.isEmpty { return [] }
        guard path.hasPrefix("/") else { throw PatchError.invalidOperation("Invalid pointer: \(path)") }
        return try path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map { part in
            let token = String(part)
            let unescaped = token.replacingOccurrences(of: "~0", with: "").replacingOccurrences(of: "~1", with: "")
            guard !unescaped.contains("~") else { throw PatchError.invalidOperation("Invalid pointer escape: \(path)") }
            return token.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
        }
    }
    private func get(_ document: AGUIJSON, _ tokens: [String]) throws -> AGUIJSON {
        guard let head = tokens.first else { return document }
        let child: AGUIJSON?
        switch document {
        case .object(let fields): child = fields[head]
        case .array(let values):
            if let index = arrayIndex(head), values.indices.contains(index) { child = values[index] } else { child = nil }
        default: child = nil
        }
        guard let child else { throw PatchError.pathNotFound("/" + tokens.joined(separator: "/")) }
        return try get(child, Array(tokens.dropFirst()))
    }
    private func edit(_ document: AGUIJSON, _ tokens: [String], _ value: AGUIJSON?, _ kind: Edit) throws -> AGUIJSON {
        guard let head = tokens.first else {
            if kind == .remove { throw PatchError.invalidOperation("Cannot remove root") }
            return value!
        }
        let tail = Array(tokens.dropFirst())
        switch document {
        case .object(var fields):
            if tail.isEmpty {
                if kind != .add && fields[head] == nil { throw PatchError.pathNotFound(head) }
                if kind == .remove { fields.removeValue(forKey: head) } else { fields[head] = value }
            } else {
                guard let child = fields[head] else { throw PatchError.pathNotFound(head) }
                fields[head] = try edit(child, tail, value, kind)
            }
            return .object(fields)
        case .array(var values):
            let index = head == "-" && kind == .add && tail.isEmpty ? values.count : arrayIndex(head)
            guard let index, index >= 0 else { throw PatchError.pathNotFound(head) }
            if tail.isEmpty {
                if kind == .add {
                    guard index <= values.count else { throw PatchError.pathNotFound(head) }
                    values.insert(value!, at: index)
                } else {
                    guard values.indices.contains(index) else { throw PatchError.pathNotFound(head) }
                    if kind == .remove { values.remove(at: index) } else { values[index] = value! }
                }
            } else {
                guard values.indices.contains(index) else { throw PatchError.pathNotFound(head) }
                values[index] = try edit(values[index], tail, value, kind)
            }
            return .array(values)
        default: throw PatchError.pathNotFound(head)
        }
    }
    private func arrayIndex(_ token: String) -> Int? {
        guard token == "0" || (!token.isEmpty && token.first != "0" &&
            token.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 })) else { return nil }
        return Int(token)
    }

    private func equal(_ lhs: AGUIJSON, _ rhs: AGUIJSON) -> Bool {
        switch (lhs, rhs) {
        case (.number(let a), .number(let b)):
            return normalizedNumber(a) == normalizedNumber(b)
        case (.array(let a), .array(let b)):
            return a.count == b.count && zip(a, b).allSatisfy { equal($0, $1) }
        case (.object(let a), .object(let b)):
            return a.count == b.count && a.allSatisfy { key, value in
                b[key].map { equal(value, $0) } ?? false
            }
        default: return lhs == rhs
        }
    }

    private func normalizedNumber(_ value: String) -> String {
        let parts = value.lowercased().split(separator: "e", omittingEmptySubsequences: false)
        let mantissa = String(parts[0])
        let negative = mantissa.hasPrefix("-")
        let unsigned = negative ? String(mantissa.dropFirst()) : mantissa
        let decimal = unsigned.split(separator: ".", omittingEmptySubsequences: false)
        var digits = decimal.joined()
        guard digits.contains(where: { $0 != "0" }) else { return "0" }
        let fractionCount = decimal.count == 2 ? decimal[1].count : 0
        let trailingCount = digits.reversed().prefix(while: { $0 == "0" }).count
        digits = String(digits.drop(while: { $0 == "0" }).dropLast(trailingCount))
        let exponent = parts.count == 2 ? String(parts[1]) : "0"
        return (negative ? "-" : "") + digits + "e" +
            adjustedExponent(exponent, by: trailingCount - fractionCount)
    }

    /// Adds a bounded mantissa shift to an exponent of arbitrary decimal length.
    private func adjustedExponent(_ exponent: String, by shift: Int) -> String {
        let exponentNegative = exponent.hasPrefix("-")
        let exponentDigits = exponent.trimmingCharacters(in: CharacterSet(charactersIn: "+-"))
        let a = Array(exponentDigits.utf8.reversed()).map { Int($0 - 48) }
        let b = Array(String(shift.magnitude).utf8.reversed()).map { Int($0 - 48) }
        let shiftNegative = shift < 0
        let negative: Bool
        let magnitude: [Int]
        if exponentNegative == shiftNegative {
            magnitude = addDigits(a, b)
            negative = exponentNegative
        } else if compareDigits(a, b) >= 0 {
            magnitude = subtractDigits(a, b)
            negative = exponentNegative
        } else {
            magnitude = subtractDigits(b, a)
            negative = shiftNegative
        }
        let canonical = magnitude.reversed().map(String.init).joined()
        return (negative && canonical != "0" ? "-" : "") + canonical
    }

    private func compareDigits(_ a: [Int], _ b: [Int]) -> Int {
        let lhs = Array(a.reversed().drop(while: { $0 == 0 }))
        let rhs = Array(b.reversed().drop(while: { $0 == 0 }))
        if lhs.count != rhs.count { return lhs.count < rhs.count ? -1 : 1 }
        for (x, y) in zip(lhs, rhs) where x != y { return x < y ? -1 : 1 }
        return 0
    }

    private func addDigits(_ a: [Int], _ b: [Int]) -> [Int] {
        var result: [Int] = []
        var carry = 0
        for index in 0..<max(a.count, b.count) {
            let sum = (index < a.count ? a[index] : 0) +
                (index < b.count ? b[index] : 0) + carry
            result.append(sum % 10)
            carry = sum / 10
        }
        if carry != 0 { result.append(carry) }
        return result
    }

    /// Subtracts b from a when a >= b, with least significant digits first.
    private func subtractDigits(_ a: [Int], _ b: [Int]) -> [Int] {
        var result: [Int] = []
        var borrow = 0
        for index in a.indices {
            var digit = a[index] - (index < b.count ? b[index] : 0) - borrow
            borrow = digit < 0 ? 1 : 0
            if borrow != 0 { digit += 10 }
            result.append(digit)
        }
        while result.count > 1 && result.last == 0 { result.removeLast() }
        return result
    }
}
