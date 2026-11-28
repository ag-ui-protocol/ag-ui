import AGUICore
import Foundation
import XCTest
@testable import AGUIClient

/// Replays the committed corpus through the same HTTP/SSE path as HttpAgent.
final class StreamConformanceTests: XCTestCase {
    private let skippedFixtures: [String: String] = [
        "era-0-0-39-flattens-content": "optional 0.0.39 peer-era translation (conformance README)",
        "era-0-0-45-thinking-translated": "optional 0.0.45 peer-era translation (conformance README)",
        "era-0-0-47-upgrades-binary-content": "optional 0.0.47 peer-era translation (conformance README)",
        "era-0-0-57-subagent-dropped-with-warning": "optional 0.0.57 peer-era translation (conformance README)",
        "era-current-peer-keeps-modern-content": "peer-era translation fixture (conformance README)",
        "era-pinned-peer-omits-protocol-version": "optional pinned peer-era request translation (conformance README)",
        "unknown-enum-value-role-fatal": "admitted TypeScript enum gap contradicts protocol (conformance README)"
    ]
    private let expectationKeys: Set<String> = [
        "outcome", "errorContains", "runError", "eventTypes", "eventTypesAbsent",
        "eventPaths", "eventAbsentPaths", "warnings", "noWarnings", "messageCount",
        "messages", "state", "request", "requestAbsentPaths"
    ]

    func testCommittedStreamCorpus() async throws {
        let directory = try corpusDirectory()
        let manifest = try String(contentsOf: directory.appendingPathComponent("MANIFEST.txt"), encoding: .utf8)
            .split(separator: "\n").map(String.init).filter { !$0.hasPrefix("#") && !$0.isEmpty }
        let actual = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertEqual(manifest, actual, "Conformance manifest must match the fixture directory in both directions")
        guard manifest == actual else { return }
        XCTAssertTrue(Set(skippedFixtures.keys).isSubset(of: Set(manifest.map { String($0.dropLast(5)) })),
                      "Swift skip list names a fixture absent from MANIFEST.txt")
        guard Set(skippedFixtures.keys).isSubset(of: Set(manifest.map { String($0.dropLast(5)) })) else { return }

        for filename in manifest {
            let fixture = try object(try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent(filename))))
            let name = try string(fixture["name"])
            XCTAssertEqual(filename, "\(name).json")
            _ = try string(fixture["area"])
            let expect = try resolvedExpectation(fixture)
            let unknown = Set(expect.keys).subtracting(expectationKeys)
            XCTAssertTrue(unknown.isEmpty, "\(name): unknown expectation keys \(unknown)")
            guard unknown.isEmpty else { continue }
            guard let stream = fixture["stream"] as? [[String: Any]] else {
                XCTFail("\(name): stream is missing or malformed"); continue
            }

            // README.md identifies exactly these corpus assertions as client-specific relaxations.
            if let reason = skippedFixtures[name] {
                print("SKIP \(name): \(reason)")
                continue
            }

            let result = await replay(fixture: fixture, stream: stream)
            let failures = check(expect: expect, result: result)
            if failures.isEmpty {
                print("PASS \(name)")
            } else {
                XCTFail("\(name): \(failures.map(\.description).joined(separator: "; "))")
            }
        }
    }

    private func corpusDirectory() throws -> URL {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent("spec/1.0/conformance/streams")
            if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("MANIFEST.txt").path) {
                return candidate
            }
            directory.deleteLastPathComponent()
        }
        throw HarnessError("cannot find spec/1.0/conformance/streams from \(#filePath)")
    }

    private func replay(fixture: [String: Any], stream: [[String: Any]]) async -> ReplayResult {
        let bytes = stream.reduce(into: Data()) { data, event in
            // Matches the TypeScript replay server's timestamp fill, leaving all other JSON untouched.
            var wire = event
            if wire["timestamp"] == nil || wire["timestamp"] is NSNull {
                wire["timestamp"] = Int64(Date().timeIntervalSince1970 * 1000)
            }
            if let json = try? JSONSerialization.data(withJSONObject: wire, options: [.fragmentsAllowed]) {
                data.append(Data("data: ".utf8)); data.append(json); data.append(Data("\n\n".utf8))
            }
        }
        let client = FixtureHTTPClient(bytes: bytes)
        let agent = HttpAgent(configuration: HttpAgentConfiguration(baseURL: URL(string: "https://fixture.invalid")!), httpClient: client)
        let recorder = FixtureRecorder()
        let first = stream.first ?? [:]
        var inputObject = (fixture["input"] as? [String: Any]) ?? [:]
        inputObject["threadId"] = first["threadId"] as? String ?? "fixture-thread"
        inputObject["runId"] = first["runId"] as? String ?? "fixture-run"
        let input: RunAgentInput
        do {
            input = try JSONDecoder().decode(RunAgentInput.self, from: JSONSerialization.data(withJSONObject: inputObject))
        } catch {
            return ReplayResult(events: [], messages: [], state: nil, request: nil, error: "input decoding: \(error)")
        }
        var failure: String?
        do { try await agent.runAgent(input: input, subscriber: recorder) }
        catch { failure = String(describing: error) }
        let request = await client.requestJSON()
        let events = await recorder.events
        let messages: Any
        do {
            let output = RunAgentInput(threadId: "t", runId: "r", messages: await agent.messages)
            let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(output)) as? [String: Any]
            messages = json?["messages"] ?? []
        } catch { messages = [] }
        let state = try? JSONSerialization.jsonObject(with: await agent.state, options: [.fragmentsAllowed])
        return ReplayResult(events: events, messages: messages, state: state, request: request, error: failure)
    }

    private func resolvedExpectation(_ fixture: [String: Any]) throws -> [String: Any] {
        var resolved = try object(fixture["expect"])
        if let overrides = fixture["expectOverrides"] as? [String: Any],
           let typescript = overrides["typescript"] {
            let values = try object(typescript)
            guard values["intentional"] as? String != nil else {
                throw HarnessError("TypeScript override must explain its divergence")
            }
            for (key, value) in values where key != "intentional" { resolved[key] = value }
        }
        return resolved
    }

    func testTypeScriptOverrideAddsSubagentTerminalOrderAssertion() throws {
        let url = try corpusDirectory().appendingPathComponent("subagent-terminal-closes-open-chunk-stream.json")
        let fixture = try object(JSONSerialization.jsonObject(with: Data(contentsOf: url)))
        let resolved = try resolvedExpectation(fixture)
        let types = try XCTUnwrap(resolved["eventTypes"] as? [String])
        let end = try XCTUnwrap(types.firstIndex(of: "TEXT_MESSAGE_END"))
        let terminal = try XCTUnwrap(types.firstIndex(of: "SUBAGENT_FINISHED"))
        XCTAssertLessThan(end, terminal)
        let wrong = types.enumerated().map { index, type -> [String: Any] in
            ["type": types[index == end ? terminal : index == terminal ? end : index]]
        }
        let failures = check(expect: resolved, result: ReplayResult(events: wrong, messages: [], state: nil, request: nil, error: nil))
        XCTAssertTrue(failures.contains { $0.key == "eventTypes" })
    }

    func testReasoningScopesRejectOrphansDuplicatesAndOpenTerminals() async {
        let started: [String: Any] = ["type": "RUN_STARTED", "threadId": "t", "runId": "r"]
        let finished: [String: Any] = ["type": "RUN_FINISHED", "threadId": "t", "runId": "r"]
        let spanStart: [String: Any] = ["type": "REASONING_START", "messageId": "span"]
        let spanEnd: [String: Any] = ["type": "REASONING_END", "messageId": "span"]
        let messageStart: [String: Any] = ["type": "REASONING_MESSAGE_START", "messageId": "message", "role": "reasoning"]
        let messageEnd: [String: Any] = ["type": "REASONING_MESSAGE_END", "messageId": "message"]
        let cases: [([[String: Any]], String)] = [
            ([started, spanEnd], "No active reasoning span"),
            ([started, spanStart, spanStart], "already open"),
            ([started, messageStart, messageStart], "already open"),
            ([started, spanStart, finished], "reasoning span"),
            ([started, messageStart, finished], "reasoning message"),
            ([started, spanStart, messageStart, messageEnd, spanEnd, finished], "")
        ]
        for (stream, needle) in cases {
            let result = await replay(fixture: [:], stream: stream)
            if needle.isEmpty { XCTAssertNil(result.error) }
            else { XCTAssertTrue(result.error?.contains(needle) == true, "\(stream): \(result.error ?? "no error")") }
        }
    }

    func testRunErrorRestartClearsOpenVerifierScopes() async {
        let stream: [[String: Any]] = [
            ["type": "RUN_STARTED", "threadId": "t", "runId": "r1"],
            ["type": "TEXT_MESSAGE_START", "messageId": "open", "role": "assistant"],
            ["type": "RUN_ERROR", "message": "first run failed"],
            ["type": "RUN_STARTED", "threadId": "t", "runId": "r2"],
            ["type": "RUN_FINISHED", "threadId": "t", "runId": "r2"]
        ]
        let result = await replay(fixture: [:], stream: stream)
        XCTAssertNil(result.error)
        XCTAssertEqual(result.events.compactMap { $0["type"] as? String },
            ["RUN_STARTED", "TEXT_MESSAGE_START", "RUN_ERROR", "RUN_STARTED", "RUN_FINISHED"])
    }

    func testRunStartedStripsFutureFieldAndRejectsMalformedKnownField() async {
        let terminal: [String: Any] = ["type": "RUN_FINISHED", "threadId": "t", "runId": "r"]
        let valid = await replay(fixture: [:], stream: [
            ["type": "RUN_STARTED", "threadId": "t", "runId": "r", "futureProp": 42], terminal
        ])
        XCTAssertNil(valid.error)
        XCTAssertNil(valid.events.first?["futureProp"])

        let malformed = await replay(fixture: [:], stream: [
            ["type": "RUN_STARTED", "threadId": "t", "runId": "r", "parentRunId": 42], terminal
        ])
        XCTAssertTrue(malformed.error?.contains("parentRunId") == true)
        XCTAssertTrue(malformed.events.isEmpty)
    }

    func testEventSubscriberMutationStopsDefaultApplication() async throws {
        let first = StoppingEventSubscriber()
        let second = CountingEventSubscriber()
        let input = RunAgentInput(threadId: "t", runId: "r")
        let source = AsyncThrowingStream<any AGUIEvent, Error> { continuation in
            continuation.yield(TextMessageStartEvent(messageId: "assistant", role: "assistant"))
            continuation.finish()
        }
        var finalMessages: [any Message] = []
        for try await state in source.applyEvents(input: input, subscribers: [first, second]) {
            if let messages = state.messages { finalMessages = messages }
        }
        XCTAssertEqual(finalMessages.map(\.id), ["substituted"])
        let firstCalls = await first.calls
        let secondCalls = await second.calls
        XCTAssertEqual(firstCalls, 1)
        XCTAssertEqual(secondCalls, 0)
    }

    private func check(expect: [String: Any], result: ReplayResult) -> [ExpectationFailure] {
        var failures: [ExpectationFailure] = []
        func fail(_ key: String, _ detail: String) { failures.append(ExpectationFailure(key: key, detail: detail)) }
        if let value = expect["outcome"] as? String {
            let actual = result.error == nil ? "completed" : "failed"
            if value != actual { fail("outcome", "expected \(value), got \(actual): \(result.error ?? "")") }
        }
        if let needle = expect["errorContains"] as? String, !(result.error ?? "").contains(needle) {
            fail("errorContains", "expected \(needle), got \(result.error ?? "none")")
        }
        let runErrors = result.events.filter { ($0["type"] as? String) == "RUN_ERROR" }.compactMap { $0["message"] as? String }
        if let value = expect["runError"] as? Bool, value != !runErrors.isEmpty {
            fail("runError", "expected \(value), got \(runErrors)")
        } else if let needle = expect["runError"] as? String, !runErrors.contains(where: { $0.contains(needle) }) {
            fail("runError", "expected \(needle), got \(runErrors)")
        }
        let types = result.events.compactMap { $0["type"] as? String }
        if let expected = expect["eventTypes"] as? [String], expected != types { fail("eventTypes", "expected \(expected), got \(types)") }
        if let absent = expect["eventTypesAbsent"] as? [String] {
            for type in absent where types.contains(type) { fail("eventTypesAbsent", "\(type) was delivered") }
        }
        if let paths = expect["eventPaths"] as? [String: Any] {
            for (path, value) in paths {
                let found = eventPath(path, in: result.events)
                if found == nil || !subset(value, found!) { fail("eventPaths", "\(path) expected \(value), got \(String(describing: found))") }
            }
        }
        if let paths = expect["eventAbsentPaths"] as? [String] {
            for path in paths where eventPath(path, in: result.events) != nil { fail("eventAbsentPaths", "\(path) exists") }
        }
        if let count = expect["messageCount"] as? Int, (result.messages as? [Any])?.count != count {
            fail("messageCount", "expected \(count), got \((result.messages as? [Any])?.count ?? -1)")
        }
        if let value = expect["messages"], !subset(value, result.messages) { fail("messages", "expected subset \(value), got \(result.messages)") }
        if let value = expect["state"], result.state == nil || !subset(value, result.state!) { fail("state", "expected subset \(value), got \(String(describing: result.state))") }
        if let value = expect["request"], result.request == nil || !subset(value, result.request!) { fail("request", "expected subset \(value), got \(String(describing: result.request))") }
        if let paths = expect["requestAbsentPaths"] as? [String] {
            for path in paths where lookup(path, in: result.request) != nil { fail("requestAbsentPaths", "\(path) exists") }
        }
        if expect["warnings"] != nil { print("SKIP warning substrings: SHOULD-level diagnostic (conformance README)") }
        if expect["noWarnings"] != nil { print("SKIP noWarnings: SHOULD-level diagnostic (conformance README)") }
        return failures
    }

    private func eventPath(_ path: String, in events: [[String: Any]]) -> Any? {
        let parts = path.split(separator: ".", maxSplits: 1).map(String.init)
        guard parts.count == 2, let index = Int(parts[0]), events.indices.contains(index) else { return nil }
        return lookup(parts[1], in: events[index])
    }

    private func lookup(_ path: String, in value: Any?) -> Any? {
        var current = value
        for part in path.split(separator: ".") {
            if let dictionary = current as? [String: Any] { current = dictionary[String(part)] }
            else if let array = current as? [Any], let index = Int(part), array.indices.contains(index) { current = array[index] }
            else { return nil }
        }
        return current
    }

    private func subset(_ expected: Any, _ actual: Any) -> Bool {
        if let dictionary = expected as? [String: Any] {
            guard let got = actual as? [String: Any] else { return false }
            return dictionary.allSatisfy { key, value in got[key].map { subset(value, $0) } ?? false }
        }
        if let array = expected as? [Any] {
            guard let got = actual as? [Any], array.count == got.count else { return false }
            return zip(array, got).allSatisfy { subset($0, $1) }
        }
        return (expected as? NSObject)?.isEqual(actual) ?? false
    }

    private func object(_ value: Any?) throws -> [String: Any] {
        guard let value = value as? [String: Any] else { throw HarnessError("expected JSON object") }
        return value
    }
    private func string(_ value: Any?) throws -> String {
        guard let value = value as? String else { throw HarnessError("expected string") }
        return value
    }
}

private struct HarnessError: Error { let detail: String; init(_ detail: String) { self.detail = detail } }
private struct ExpectationFailure: CustomStringConvertible {
    let key: String
    let detail: String
    var description: String { "\(key) \(detail)" }
}
private struct ReplayResult {
    let events: [[String: Any]]
    let messages: Any
    let state: Any?
    let request: [String: Any]?
    let error: String?
}

private actor FixtureHTTPClient: HTTPClient {
    let bytes: Data
    private var request: URLRequest?
    init(bytes: Data) { self.bytes = bytes }
    func execute(_ request: URLRequest) async throws -> HTTPResponse {
        self.request = request
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
        let bytes = self.bytes
        return HTTPResponse(bytes: AsyncThrowingStream { continuation in
            for byte in bytes { continuation.yield(byte) }
            continuation.finish()
        }, httpResponse: response)
    }
    func requestJSON() -> [String: Any]? {
        guard let body = request?.httpBody else { return nil }
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }
}

private actor FixtureRecorder: AgentSubscriber {
    private(set) var events: [[String: Any]] = []
    func onEvent(params: AgentEventParams) async -> AgentStateMutation? {
        let event = params.event
        var object = (event.rawEvent.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
        object["type"] = event.eventType.rawValue
        if let runError = event as? RunErrorEvent { object["message"] = runError.message; object["code"] = runError.code }
        events.append(object)
        return nil
    }
}

private actor StoppingEventSubscriber: AgentSubscriber {
    private(set) var calls = 0
    func onEvent(params: AgentEventParams) async -> AgentStateMutation? {
        calls += 1
        return AgentStateMutation(messages: [UserMessage(id: "substituted", content: "replacement")],
                                  stopPropagation: true)
    }
}

private actor CountingEventSubscriber: AgentSubscriber {
    private(set) var calls = 0
    func onEvent(params: AgentEventParams) async -> AgentStateMutation? {
        calls += 1
        return nil
    }
}
