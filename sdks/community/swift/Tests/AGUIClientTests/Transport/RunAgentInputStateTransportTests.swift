// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient
@testable import AGUICore

final class RunAgentInputStateTransportTests: XCTestCase {
    func testOutgoingRequestPreservesStateShapes() async throws {
        let mockClient = MockHTTPClient()
        let response = try await HTTPResponse.mock()
        await mockClient.setResponse(response)
        let transport = HttpTransport(
            configuration: HttpAgentConfiguration(baseURL: URL(string: "https://agent.example.com")!),
            httpClient: mockClient
        )

        for json in ["{}", "[]", "[1,2]", "42", "0", "1.5", "true", "false", #""hello""#,
                     #"[null,{"items":[0,1,true,false]}]"#] {
            let input = RunAgentInput(threadId: "t", runId: "r", state: Data(json.utf8))
            let bytes = try await transport.execute(endpoint: "/run", input: input)
            for try await _ in bytes {}

            let request = await mockClient.lastRequest
            let body = try XCTUnwrap(request?.httpBody)
            let expected = try AGUIJSON.parse(Data(json.utf8))
            XCTAssertEqual(try AGUIJSON.parse(body).object?["state"], expected, json)
            let decoded = try JSONDecoder().decode(RunAgentInput.self, from: body)
            XCTAssertEqual(try AGUIJSON.parse(decoded.state), expected, json)
        }
    }
}
