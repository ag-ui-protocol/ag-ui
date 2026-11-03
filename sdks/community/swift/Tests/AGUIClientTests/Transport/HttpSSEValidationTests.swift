// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

@testable import AGUIClient
import AGUICore
import XCTest

final class HttpSSEValidationTests: XCTestCase {
    func testBuiltHeadersReachInjectedClient() async throws {
        let client = MockHTTPClient()
        try await client.setResponse(response())
        var configuration = try HttpAgentConfiguration(baseURL: XCTUnwrap(URL(string: "https://agent.example.com")))
        configuration.bearerToken = "example-token"
        configuration.apiKey = "example-key"
        let transport = HttpTransport(configuration: configuration, httpClient: client)
        _ = try await transport.execute(endpoint: "/run", input: input)
        let request = await client.lastRequest
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer example-token")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "X-API-Key"), "example-key")
    }

    func testExplicitHeadersOverrideBuiltHeadersIgnoringCase() throws {
        var configuration = try HttpAgentConfiguration(
            baseURL: XCTUnwrap(URL(string: "https://agent.example.com")),
            headers: ["authorization": "custom-value", "x-api-key": "custom-key"]
        )
        configuration.bearerToken = "example-token"
        configuration.apiKey = "example-key"
        let built = configuration.buildHeaders()
        XCTAssertEqual(built.count, 2)
        XCTAssertEqual(built["authorization"], "custom-value")
        XCTAssertEqual(built["x-api-key"], "custom-key")
    }

    func testConfiguredHeadersReachInjectedClient() async throws {
        let client = MockHTTPClient()
        try await client.setResponse(response())
        let configuration = try HttpAgentConfiguration(
            baseURL: XCTUnwrap(URL(string: "https://agent.example.com")),
            headers: ["X-Request-Tag": "example", "accept": "text/event-stream; charset=utf-8"]
        )
        let transport = HttpTransport(configuration: configuration, httpClient: client)

        _ = try await transport.execute(endpoint: "/run", input: input, lastEventId: "cursor-2")

        let request = await client.lastRequest
        XCTAssertEqual(request?.value(forHTTPHeaderField: "X-Request-Tag"), "example")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Accept"), "text/event-stream; charset=utf-8")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Last-Event-ID"), "cursor-2")
        XCTAssertEqual(request?.httpMethod, "POST")
        let body = try XCTUnwrap(request?.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["threadId"] as? String, "thread")
    }

    func testExplicitResumeCursorOverridesConfiguredHeader() async throws {
        let client = MockHTTPClient()
        try await client.setResponse(response())
        let configuration = try HttpAgentConfiguration(
            baseURL: XCTUnwrap(URL(string: "https://agent.example.com")),
            headers: ["last-event-id": "old-cursor", "X-Request-Tag": "example"]
        )
        let transport = HttpTransport(configuration: configuration, httpClient: client)
        _ = try await transport.execute(endpoint: "/run", input: input, lastEventId: "new-cursor")
        let request = await client.lastRequest
        XCTAssertEqual(request?.value(forHTTPHeaderField: "X-Request-Tag"), "example")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Last-Event-ID"), "new-cursor")
    }

    func testAcceptsSSEMediaTypeWithParametersAndCaseVariation() async throws {
        for mediaType in ["text/event-stream", "Text/Event-Stream; charset=utf-8", " text/event-stream ; charset=UTF-8"] {
            let client = MockHTTPClient()
            try await client.setResponse(response(headers: ["content-type": mediaType], body: [65, 66]))
            let transport = try transport(client: client)
            let bytes = try await transport.execute(endpoint: "/run", input: input)
            var received: [UInt8] = []
            for try await byte in bytes {
                received.append(byte)
            }
            XCTAssertEqual(received, [65, 66])
        }
    }

    func testRejectsMissingOrInvalidSSEMediaType() async throws {
        for headers in [[:], ["Content-Type": "application/json"], ["Content-Type": "text/event-streaming"], ["Content-Type": ";text/event-stream"], ["Content-Type": ""]] {
            let client = MockHTTPClient()
            try await client.setResponse(response(headers: headers))
            let transport = try transport(client: client)
            do {
                _ = try await transport.execute(endpoint: "/run", input: input)
                XCTFail("Expected invalidResponse for \(headers)")
            } catch let error as ClientError {
                XCTAssertEqual(error, .invalidResponse)
            }
        }
    }

    func testAcceptsAnySuccessfulStatusWithSSEMediaType() async throws {
        for status in [201, 202, 206, 299] {
            let client = MockHTTPClient()
            try await client.setResponse(response(status: status, body: [65]))
            let transport = try transport(client: client)
            let bytes = try await transport.execute(endpoint: "/run", input: input)
            var received: [UInt8] = []
            for try await byte in bytes {
                received.append(byte)
            }
            XCTAssertEqual(received, [65], "HTTP \(status)")
        }
    }

    func testHTTPStatusErrorTakesPrecedenceOverMediaTypeError() async throws {
        for status in [302, 400, 404, 500] {
            let client = MockHTTPClient()
            try await client.setResponse(response(status: status, headers: [:]))
            let transport = try transport(client: client)
            do {
                _ = try await transport.execute(endpoint: "/run", input: input)
                XCTFail("Expected HTTP error")
            } catch let error as ClientError {
                XCTAssertEqual(error, .httpError(statusCode: status))
            }
        }
    }

    private var input: RunAgentInput { RunAgentInput(threadId: "thread", runId: "run") }

    private func transport(client: MockHTTPClient) throws -> HttpTransport {
        let url = try XCTUnwrap(URL(string: "https://agent.example.com"))
        return HttpTransport(configuration: HttpAgentConfiguration(baseURL: url), httpClient: client)
    }

    private func response(
        status: Int = 200,
        headers: [String: String] = ["Content-Type": "text/event-stream"],
        body: [UInt8] = []
    ) throws -> HTTPResponse {
        let url = try XCTUnwrap(URL(string: "https://agent.example.com/run"))
        let metadata = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers))
        let bytes = AsyncThrowingStream<UInt8, Error> { continuation in
            for byte in body {
                continuation.yield(byte)
            }
            continuation.finish()
        }
        return HTTPResponse(bytes: bytes, httpResponse: metadata)
    }
}
