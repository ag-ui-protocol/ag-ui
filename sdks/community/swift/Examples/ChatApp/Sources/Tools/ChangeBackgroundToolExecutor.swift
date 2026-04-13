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

import AGUICore
import AGUITools
import Foundation

// MARK: - ChangeBackgroundToolExecutor

/// Client-side tool executor that updates the chat background color.
///
/// Registered with the `StatefulAgUiAgent`'s tool registry so the agent can
/// call `change_background` locally instead of routing through a server round-trip.
///
/// Accepts either a `"color"` or `"hex"` key in the arguments JSON to maintain
/// backward compatibility with the existing `CustomEvent`-based approach.
actor ChangeBackgroundToolExecutor: ToolExecutor {

    // MARK: - Tool definition

    nonisolated let tool: Tool = Tool(
        name: "change_background",
        description: "Changes the chat background color. Accepts a hex color string.",
        parameters: Data("""
        {
            "type": "object",
            "properties": {
                "color": {
                    "type": "string",
                    "description": "Hex color string (e.g. #FF5733 or #FF5733CC)"
                }
            },
            "required": ["color"]
        }
        """.utf8)
    )

    // MARK: - Private state

    /// Called on the main actor whenever the agent requests a background change.
    private let onBackground: @Sendable (String) async -> Void

    // MARK: - Init

    init(onBackground: @escaping @Sendable (String) async -> Void) {
        self.onBackground = onBackground
    }

    // MARK: - ToolExecutor

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        guard let colorValue = parseColor(from: context.toolCall.function.arguments) else {
            throw ToolExecutionError.validationFailed(
                message: "Missing or invalid 'color' / 'hex' argument"
            )
        }
        await onBackground(colorValue)
        return .success(message: "Background updated to \(colorValue)")
    }

    nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult {
        guard let colorValue = parseColor(from: toolCall.function.arguments) else {
            return .invalid(errors: ["Missing 'color' or 'hex' argument in tool call arguments"])
        }
        guard isValidHex(colorValue) else {
            return .invalid(errors: [
                "Invalid hex color '\(colorValue)'. Expected #RRGGBB or #RRGGBBAA format."
            ])
        }
        return .valid
    }

    // MARK: - Private helpers

    /// Extracts the color value from JSON arguments string.
    ///
    /// Accepts both `"color"` and `"hex"` keys for compatibility with the existing
    /// `CustomEvent`-based change_background implementation.
    private nonisolated func parseColor(from arguments: String) -> String? {
        guard
            let data = arguments.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json["color"] as? String ?? json["hex"] as? String
    }

    /// Returns `true` if `value` is a valid 6- or 8-character hex color string.
    ///
    /// Strips a leading `#` before checking.
    private nonisolated func isValidHex(_ value: String) -> Bool {
        let cleaned = value
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "#", with: "")
        guard cleaned.count == 6 || cleaned.count == 8 else { return false }
        return cleaned.allSatisfy { "0123456789abcdefABCDEF".contains($0) }
    }
}
