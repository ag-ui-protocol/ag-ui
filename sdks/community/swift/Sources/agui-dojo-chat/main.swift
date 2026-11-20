import AGUICore
import AGUIClient
import Foundation

@main
struct DojoChat {
    static func main() async throws {
        let prompt = CommandLine.arguments.dropFirst().joined(separator: " ")
        guard !prompt.isEmpty else {
            throw UsageError.missingPrompt
        }
        let baseURLString = ProcessInfo.processInfo.environment["AGUI_DOJO_BASE_URL"] ?? "http://127.0.0.1:18000"
        guard let baseURL = URL(string: baseURLString) else {
            throw UsageError.invalidURL
        }

        print("Source Git revision: \(try command("/usr/bin/git", ["rev-parse", "HEAD"]))")
        print("Swift version: \(try command("/usr/bin/swift", ["--version"]))")

        let input = RunAgentInput(
            threadId: UUID().uuidString,
            runId: UUID().uuidString,
            protocolVersion: nil, // This dojo server predates the optional 1.0 field.
            messages: [UserMessage(id: UUID().uuidString, content: prompt)]
        )
        let agent = HttpAgent(baseURL: baseURL)
        let events = try await agent.run(input, endpoint: "/agentic_chat")
        var receivedText = false
        for try await event in events {
            if let content = event as? TextMessageContentEvent {
                print(content.delta, terminator: "")
                fflush(stdout)
                receivedText = true
            }
        }
        print()
        if !receivedText { throw UsageError.emptyResponse }
    }

    private static func command(_ path: String, _ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let text = String(data: data, encoding: .utf8) else { throw UsageError.commandFailed }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    enum UsageError: Error {
        case missingPrompt, invalidURL, commandFailed, emptyResponse
    }
}
