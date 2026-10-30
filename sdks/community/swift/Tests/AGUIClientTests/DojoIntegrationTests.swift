import AGUICore
import XCTest
@testable import AGUIClient

final class DojoIntegrationTests: XCTestCase {
    func testAgenticChatStreamsAssistantText() throws {
        guard let rawURL = ProcessInfo.processInfo.environment["AGUI_DOJO_BASE_URL"] else {
            throw XCTSkip("Set AGUI_DOJO_BASE_URL to run against an AG-UI dojo server")
        }
        let baseURL = try XCTUnwrap(URL(string: rawURL))
        let finished = expectation(description: "dojo stream completes")
        Task {
            defer { finished.fulfill() }
            do {
                try await assertStream(baseURL: baseURL)
            } catch {
                XCTFail("Dojo stream failed: \(error)")
            }
        }
        wait(for: [finished], timeout: 30)
    }

    private func assertStream(baseURL: URL) async throws {
        let input = RunAgentInput(
            threadId: UUID().uuidString,
            runId: UUID().uuidString,
            protocolVersion: nil, // The local dojo rejects unknown request fields.
            messages: [UserMessage(id: UUID().uuidString, content: "Say hello")]
        )
        let agent = HttpAgent(baseURL: baseURL)
        let stream = try await agent.run(input, endpoint: "/agentic_chat")
        var assistantText = ""
        for try await event in stream {
            if let content = event as? TextMessageContentEvent {
                assistantText += content.delta
            }
        }
        XCTAssertFalse(assistantText.isEmpty)
        withExtendedLifetime(agent) {}
    }
}
