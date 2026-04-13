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
import XCTest
@testable import ChatApp

// MARK: - ChangeBackgroundToolExecutorTests

@MainActor
final class ChangeBackgroundToolExecutorTests: XCTestCase {

    // MARK: - Helpers

    /// Thread-safe capture box for async callbacks.
    private final class StringCapture: @unchecked Sendable {
        var value: String?
    }

    private func makeContext(arguments: String) -> ToolExecutionContext {
        ToolExecutionContext(
            toolCall: ToolCall(
                id: "tc-test",
                function: FunctionCall(name: "change_background", arguments: arguments)
            )
        )
    }

    // MARK: - Execute

    func test_execute_colorKey_callsCallbackWithHex() async throws {
        let capture = StringCapture()
        let executor = ChangeBackgroundToolExecutor { hex in capture.value = hex }

        let result = try await executor.execute(context: makeContext(arguments: "{\"color\":\"#FF5733\"}"))

        XCTAssertTrue(result.success)
        XCTAssertEqual(capture.value, "#FF5733")
    }

    func test_execute_hexKey_callsCallbackWithHex() async throws {
        let capture = StringCapture()
        let executor = ChangeBackgroundToolExecutor { hex in capture.value = hex }

        let result = try await executor.execute(context: makeContext(arguments: "{\"hex\":\"#AABBCC\"}"))

        XCTAssertTrue(result.success)
        XCTAssertEqual(capture.value, "#AABBCC")
    }

    func test_execute_missingColorKey_throws() async {
        let executor = ChangeBackgroundToolExecutor { _ in }

        do {
            _ = try await executor.execute(context: makeContext(arguments: "{}"))
            XCTFail("Expected an error to be thrown")
        } catch {
            // Expected
        }
    }

    // MARK: - Validate

    func test_validate_validHex6Digits_returnsValid() {
        let executor = ChangeBackgroundToolExecutor { _ in }
        let result = executor.validate(toolCall: ToolCall(
            id: "tc1",
            function: FunctionCall(name: "change_background", arguments: "{\"color\":\"#FF5733\"}")
        ))
        XCTAssertTrue(result.isValid)
    }

    func test_validate_validHex8Digits_returnsValid() {
        let executor = ChangeBackgroundToolExecutor { _ in }
        let result = executor.validate(toolCall: ToolCall(
            id: "tc1",
            function: FunctionCall(name: "change_background", arguments: "{\"color\":\"#FF5733AA\"}")
        ))
        XCTAssertTrue(result.isValid)
    }

    func test_validate_invalidHex_returnsInvalid() {
        let executor = ChangeBackgroundToolExecutor { _ in }
        let result = executor.validate(toolCall: ToolCall(
            id: "tc1",
            function: FunctionCall(name: "change_background", arguments: "{\"color\":\"not-a-hex\"}")
        ))
        XCTAssertFalse(result.isValid)
        XCTAssertFalse(result.errors.isEmpty)
    }

    func test_validate_missingColorKey_returnsInvalid() {
        let executor = ChangeBackgroundToolExecutor { _ in }
        let result = executor.validate(toolCall: ToolCall(
            id: "tc1",
            function: FunctionCall(name: "change_background", arguments: "{}")
        ))
        XCTAssertFalse(result.isValid)
    }

    func test_validate_hexKeyAccepted() {
        let executor = ChangeBackgroundToolExecutor { _ in }
        let result = executor.validate(toolCall: ToolCall(
            id: "tc1",
            function: FunctionCall(name: "change_background", arguments: "{\"hex\":\"#AABBCC\"}")
        ))
        XCTAssertTrue(result.isValid)
    }

    // MARK: - Registry

    func test_toolRegistry_registersChangeBackground() async throws {
        let registry = try await ChatAppToolRegistry.makeRegistry { _ in }

        let isRegistered = await registry.isToolRegistered(toolName: "change_background")
        XCTAssertTrue(isRegistered)
    }

    func test_toolRegistry_hasCorrectToolName() async throws {
        let registry = try await ChatAppToolRegistry.makeRegistry { _ in }

        let tools = await registry.allTools()
        XCTAssertEqual(tools.count, 1)
        XCTAssertEqual(tools.first?.name, "change_background")
    }
}
