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

import XCTest
@testable import ChatApp

// MARK: - Phase 4: A2UIComponent Decoding Tests

final class A2UIComponentTests: XCTestCase {

    // MARK: - Helpers

    private func decode(_ json: String) throws -> A2UIComponent {
        let data = json.data(using: .utf8)!
        return try JSONDecoder().decode(A2UIComponent.self, from: data)
    }

    // MARK: - Tests

    func test_decodesButton() throws {
        let json = """
        {"type": "button", "label": "Click me", "actionId": "submit"}
        """
        let component = try decode(json)
        guard case .button(let label, let actionId) = component else {
            XCTFail("Expected .button, got \(component)")
            return
        }
        XCTAssertEqual(label, "Click me")
        XCTAssertEqual(actionId, "submit")
    }

    func test_decodesText() throws {
        let json = """
        {"type": "text", "content": "Hello World"}
        """
        let component = try decode(json)
        guard case .text(let content, _) = component else {
            XCTFail("Expected .text, got \(component)")
            return
        }
        XCTAssertEqual(content, "Hello World")
    }

    func test_decodesVStack_withChildren() throws {
        let json = """
        {"type": "vStack", "children": [
            {"type": "text", "content": "Child 1"},
            {"type": "divider"}
        ]}
        """
        let component = try decode(json)
        guard case .vStack(let children) = component else {
            XCTFail("Expected .vStack, got \(component)")
            return
        }
        XCTAssertEqual(children.count, 2)
        if case .text(let c, _) = children[0] { XCTAssertEqual(c, "Child 1") } else { XCTFail() }
        if case .divider = children[1] { /* pass */ } else { XCTFail() }
    }

    func test_decodesMarkdown() throws {
        let json = """
        {"type": "markdown", "content": "**Bold text**"}
        """
        let component = try decode(json)
        guard case .markdown(let content) = component else {
            XCTFail("Expected .markdown, got \(component)")
            return
        }
        XCTAssertEqual(content, "**Bold text**")
    }

    func test_decodesProgress() throws {
        let json = """
        {"type": "progress", "value": 0.75, "total": 1.0}
        """
        let component = try decode(json)
        guard case .progress(let value, let total) = component else {
            XCTFail("Expected .progress, got \(component)")
            return
        }
        XCTAssertEqual(value, 0.75, accuracy: 0.001)
        XCTAssertEqual(total, 1.0, accuracy: 0.001)
    }

    func test_decodesTable() throws {
        let json = """
        {"type": "table", "headers": ["Name", "Score"], "rows": [["Alice", "100"], ["Bob", "95"]]}
        """
        let component = try decode(json)
        guard case .table(let headers, let rows) = component else {
            XCTFail("Expected .table, got \(component)")
            return
        }
        XCTAssertEqual(headers, ["Name", "Score"])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0], ["Alice", "100"])
    }

    func test_unknownType_doesNotThrow() throws {
        let json = """
        {"type": "unknown_future_type_v99", "someField": "someValue"}
        """
        let component = try decode(json)
        guard case .unknown = component else {
            XCTFail("Expected .unknown, got \(component)")
            return
        }
    }

    func test_missingType_fallsBackToUnknown() throws {
        let json = """
        {"someField": "someValue"}
        """
        let component = try decode(json)
        guard case .unknown = component else {
            XCTFail("Expected .unknown for missing type, got \(component)")
            return
        }
    }

    func test_decodesDivider() throws {
        let json = """
        {"type": "divider"}
        """
        let component = try decode(json)
        guard case .divider = component else {
            XCTFail("Expected .divider, got \(component)")
            return
        }
    }

    func test_decodesCard_withTitleAndChildren() throws {
        let json = """
        {"type": "card", "title": "My Card", "children": [{"type": "text", "content": "Body"}]}
        """
        let component = try decode(json)
        guard case .card(let title, let children) = component else {
            XCTFail("Expected .card, got \(component)")
            return
        }
        XCTAssertEqual(title, "My Card")
        XCTAssertEqual(children.count, 1)
    }

    func test_decodesBadge() throws {
        let json = """
        {"type": "badge", "label": "NEW", "color": "FF0000"}
        """
        let component = try decode(json)
        guard case .badge(let label, let color) = component else {
            XCTFail("Expected .badge, got \(component)")
            return
        }
        XCTAssertEqual(label, "NEW")
        XCTAssertEqual(color, "FF0000")
    }
}
