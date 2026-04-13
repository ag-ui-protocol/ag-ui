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
@testable import AGUICore

/// Tests for the Role enum
final class RoleTests: XCTestCase {
    // MARK: - Encoding Tests

    func testDeveloperRoleEncoding() throws {
        let role = Role.developer
        let encoded = try JSONEncoder().encode(role)
        let json = String(data: encoded, encoding: .utf8)
        XCTAssertEqual(json, "\"developer\"")
    }

    func testSystemRoleEncoding() throws {
        let role = Role.system
        let encoded = try JSONEncoder().encode(role)
        let json = String(data: encoded, encoding: .utf8)
        XCTAssertEqual(json, "\"system\"")
    }

    func testAssistantRoleEncoding() throws {
        let role = Role.assistant
        let encoded = try JSONEncoder().encode(role)
        let json = String(data: encoded, encoding: .utf8)
        XCTAssertEqual(json, "\"assistant\"")
    }

    func testUserRoleEncoding() throws {
        let role = Role.user
        let encoded = try JSONEncoder().encode(role)
        let json = String(data: encoded, encoding: .utf8)
        XCTAssertEqual(json, "\"user\"")
    }

    func testToolRoleEncoding() throws {
        let role = Role.tool
        let encoded = try JSONEncoder().encode(role)
        let json = String(data: encoded, encoding: .utf8)
        XCTAssertEqual(json, "\"tool\"")
    }

    func testActivityRoleEncoding() throws {
        let role = Role.activity
        let encoded = try JSONEncoder().encode(role)
        let json = String(data: encoded, encoding: .utf8)
        XCTAssertEqual(json, "\"activity\"")
    }

    // MARK: - Decoding Tests

    func testDeveloperRoleDecoding() throws {
        let json = Data("\"developer\"".utf8)
        let role = try JSONDecoder().decode(Role.self, from: json)
        XCTAssertEqual(role, .developer)
    }

    func testSystemRoleDecoding() throws {
        let json = Data("\"system\"".utf8)
        let role = try JSONDecoder().decode(Role.self, from: json)
        XCTAssertEqual(role, .system)
    }

    func testAssistantRoleDecoding() throws {
        let json = Data("\"assistant\"".utf8)
        let role = try JSONDecoder().decode(Role.self, from: json)
        XCTAssertEqual(role, .assistant)
    }

    func testUserRoleDecoding() throws {
        let json = Data("\"user\"".utf8)
        let role = try JSONDecoder().decode(Role.self, from: json)
        XCTAssertEqual(role, .user)
    }

    func testToolRoleDecoding() throws {
        let json = Data("\"tool\"".utf8)
        let role = try JSONDecoder().decode(Role.self, from: json)
        XCTAssertEqual(role, .tool)
    }

    func testActivityRoleDecoding() throws {
        let json = Data("\"activity\"".utf8)
        let role = try JSONDecoder().decode(Role.self, from: json)
        XCTAssertEqual(role, .activity)
    }

    // MARK: - Round-trip Tests

    func testRoleRoundTrip() throws {
        let roles: [Role] = [.developer, .system, .assistant, .user, .tool, .activity]

        for role in roles {
            let encoded = try JSONEncoder().encode(role)
            let decoded = try JSONDecoder().decode(Role.self, from: encoded)
            XCTAssertEqual(decoded, role, "Round-trip failed for role: \(role)")
        }
    }

    // MARK: - Invalid Input Tests

    func testInvalidRoleDecoding() {
        let json = Data("\"invalid_role\"".utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(Role.self, from: json)) { error in
            XCTAssertTrue(error is DecodingError, "Expected DecodingError but got \(type(of: error))")
        }
    }

    // MARK: - Hashable & Equatable Tests

    func testRoleEquality() {
        XCTAssertEqual(Role.developer, Role.developer)
        XCTAssertNotEqual(Role.developer, Role.system)
    }

    func testRoleHashable() {
        let roleSet: Set<Role> = [.developer, .system, .assistant]
        XCTAssertTrue(roleSet.contains(.developer))
        XCTAssertTrue(roleSet.contains(.system))
        XCTAssertFalse(roleSet.contains(.user))
    }

    // MARK: - CaseIterable Tests

    func testAllRolesCount() {
        XCTAssertEqual(Role.allCases.count, 6, "Role enum should have exactly 6 cases")
    }

    func testAllRolesContainsAllValues() {
        let allRoles = Role.allCases
        XCTAssertTrue(allRoles.contains(.developer))
        XCTAssertTrue(allRoles.contains(.system))
        XCTAssertTrue(allRoles.contains(.assistant))
        XCTAssertTrue(allRoles.contains(.user))
        XCTAssertTrue(allRoles.contains(.tool))
        XCTAssertTrue(allRoles.contains(.activity))
    }
}
