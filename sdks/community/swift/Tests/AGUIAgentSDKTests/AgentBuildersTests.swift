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
@testable import AGUIAgentSDK

// MARK: - Mock ToolRegistry for builder tests

private actor BuilderMockToolRegistry: ToolRegistry {
    func allTools() async -> [Tool] { [] }
    func register(executor: any ToolExecutor) async throws {}
    func unregister(toolName: String) async -> Bool { false }
    func executor(for toolName: String) async -> (any ToolExecutor)? { nil }
    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(success: false, message: "mock")
    }
    func isToolRegistered(toolName: String) async -> Bool { false }
    func stats(for toolName: String) async -> ToolExecutionStats? { nil }
    func getAllStats() async -> [String: ToolExecutionStats] { [:] }
    func clearStats() async {}
    func getAllExecutors() async -> [String: any ToolExecutor] { [:] }
}

// MARK: - AgentBuildersTests

final class AgentBuildersTests: XCTestCase {

    private let agentURL = URL(string: "https://agent.example.com")!

    // MARK: - agentWithBearer

    func testAgentWithBearerCreatesAgUiAgent() {
        let agent = agentWithBearer(url: agentURL, token: "tok_test")
        XCTAssertNotNil(agent)
    }

    func testAgentWithBearerSetsAuthorizationHeader() {
        let agent = agentWithBearer(url: agentURL, token: "sk-secret")
        let headers = agent.config.buildHeaders()
        XCTAssertEqual(headers["Authorization"], "Bearer sk-secret")
    }

    func testAgentWithBearerStoresToken() {
        let agent = agentWithBearer(url: agentURL, token: "my-token")
        XCTAssertEqual(agent.config.bearerToken, "my-token")
    }

    // MARK: - agentWithApiKey

    func testAgentWithApiKeyCreatesAgUiAgent() {
        let agent = agentWithApiKey(url: agentURL, apiKey: "key123")
        XCTAssertNotNil(agent)
    }

    func testAgentWithApiKeyUsesDefaultHeader() {
        let agent = agentWithApiKey(url: agentURL, apiKey: "key123")
        let headers = agent.config.buildHeaders()
        XCTAssertEqual(headers["X-API-Key"], "key123")
    }

    func testAgentWithApiKeyUsesCustomHeader() {
        let agent = agentWithApiKey(url: agentURL, apiKey: "key123", header: "X-Custom-Key")
        let headers = agent.config.buildHeaders()
        XCTAssertEqual(headers["X-Custom-Key"], "key123")
        XCTAssertNil(headers["X-API-Key"])
    }

    func testAgentWithApiKeyStoresKey() {
        let agent = agentWithApiKey(url: agentURL, apiKey: "key_abc")
        XCTAssertEqual(agent.config.apiKey, "key_abc")
    }

    // MARK: - agentWithTools

    func testAgentWithToolsCreatesAgUiAgent() {
        let registry = BuilderMockToolRegistry()
        let agent = agentWithTools(url: agentURL, registry: registry)
        XCTAssertNotNil(agent)
    }

    func testAgentWithToolsSetsRegistry() {
        let registry = BuilderMockToolRegistry()
        let agent = agentWithTools(url: agentURL, registry: registry)
        XCTAssertNotNil(agent.config.toolRegistry)
    }

    // MARK: - debugAgent

    func testDebugAgentCreatesAgUiAgent() {
        let agent = debugAgent(url: agentURL)
        XCTAssertNotNil(agent)
    }

    func testDebugAgentSetsDebugFlag() {
        let agent = debugAgent(url: agentURL)
        XCTAssertTrue(agent.config.debug)
    }

    func testNonDebugAgentHasDebugFalse() {
        let agent = AgUiAgent(url: agentURL)
        XCTAssertFalse(agent.config.debug)
    }

    // MARK: - chatAgent

    func testChatAgentCreatesStatefulAgUiAgent() {
        let agent = chatAgent(url: agentURL, systemPrompt: "Be helpful.")
        XCTAssertNotNil(agent)
    }

    func testChatAgentSetsSystemPrompt() {
        let agent = chatAgent(url: agentURL, systemPrompt: "You are a pirate.")
        XCTAssertEqual(agent.config.systemPrompt, "You are a pirate.")
    }

    func testChatAgentReturnsStatefulType() {
        let agent = chatAgent(url: agentURL, systemPrompt: "Hi")
        XCTAssert(agent is StatefulAgUiAgent)
    }

    // MARK: - statefulAgent

    func testStatefulAgentCreatesStatefulAgUiAgent() {
        let agent = statefulAgent(url: agentURL, initialState: Data("{}".utf8))
        XCTAssertNotNil(agent)
    }

    func testStatefulAgentSetsInitialState() {
        let state = Data("{\"key\":\"value\"}".utf8)
        let agent = statefulAgent(url: agentURL, initialState: state)
        XCTAssertEqual(agent.config.initialState, state)
    }

    func testStatefulAgentReturnsStatefulType() {
        let agent = statefulAgent(url: agentURL, initialState: Data("{}".utf8))
        XCTAssert(agent is StatefulAgUiAgent)
    }

    // MARK: - AgUiAgentConfig.buildHeaders

    func testBuildHeadersBearerTakesEffectOverApiKey() {
        var config = AgUiAgentConfig()
        config.bearerToken = "tok"
        config.apiKey = "key"
        config.apiKeyHeader = "X-API-Key"
        let headers = config.buildHeaders()
        XCTAssertEqual(headers["Authorization"], "Bearer tok")
        XCTAssertEqual(headers["X-API-Key"], "key")
    }

    func testBuildHeadersExplicitHeadersOverrideAuth() {
        var config = AgUiAgentConfig()
        config.bearerToken = "tok"
        config.headers = ["Authorization": "Basic override"]
        let headers = config.buildHeaders()
        // Explicit headers override auth helpers
        XCTAssertEqual(headers["Authorization"], "Basic override")
    }

    func testBuildHeadersEmptyWhenNothingConfigured() {
        let config = AgUiAgentConfig()
        XCTAssertTrue(config.buildHeaders().isEmpty)
    }
}
