// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

public final class HttpAgent: Sendable {
    private let abstractAgent: AbstractAgent
    private let httpTransport: HttpTransport
    private let decoder: AGUIEventDecoder
    private let defaultEndpoint: String

    public init(baseURL: URL) {
        let config = HttpAgentConfiguration(baseURL: baseURL)
        let agentTransport = HttpAgentTransport(configuration: config)
        self.abstractAgent = AbstractAgent(transport: agentTransport, debug: config.debug)
        self.httpTransport = HttpTransport(configuration: config)
        self.decoder = AGUIEventDecoder()
        self.defaultEndpoint = "/run"
    }

    public init(configuration: HttpAgentConfiguration) {
        let agentTransport = HttpAgentTransport(configuration: configuration)
        self.abstractAgent = AbstractAgent(transport: agentTransport, debug: configuration.debug)
        self.httpTransport = HttpTransport(configuration: configuration)
        self.decoder = AGUIEventDecoder()
        self.defaultEndpoint = "/run"
    }

    public init(
        configuration: HttpAgentConfiguration,
        httpClient: any HTTPClient
    ) {
        let agentTransport = HttpAgentTransport(configuration: configuration, httpClient: httpClient)
        self.abstractAgent = AbstractAgent(transport: agentTransport, debug: configuration.debug)
        self.httpTransport = HttpTransport(configuration: configuration, httpClient: httpClient)
        self.decoder = AGUIEventDecoder()
        self.defaultEndpoint = "/run"
    }

    public func run(
        _ input: RunAgentInput,
        endpoint: String? = nil
    ) async throws -> EventStream<AsyncThrowingStream<UInt8, Error>> {
        let bytes = try await httpTransport.execute(
            endpoint: endpoint ?? defaultEndpoint,
            input: input
        )
        return EventStream(bytes: bytes, decoder: decoder)
    }

    public func run(
        threadId: String,
        runId: String,
        endpoint: String? = nil,
        configure: (RunAgentInputBuilder) -> RunAgentInputBuilder = { $0 }
    ) async throws -> EventStream<AsyncThrowingStream<UInt8, Error>> {
        let input = try configure(
            RunAgentInput.builder()
                .threadId(threadId)
                .runId(runId)
        ).build()
        return try await run(input, endpoint: endpoint)
    }

    public func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        abstractAgent.run(input: input)
    }

    public func runAgent(
        parameters: RunAgentParameters? = nil,
        subscriber: (any AgentSubscriber)? = nil
    ) async throws {
        try await abstractAgent.runAgent(parameters: parameters, subscriber: subscriber)
    }

    public func runAgentObservable(
        input: RunAgentInput
    ) -> AsyncThrowingStream<any AGUIEvent, Error> {
        abstractAgent.runAgentObservable(input: input)
    }

    public var messages: [any Message] { get async { await abstractAgent.messages } }
    public var state: State { get async { await abstractAgent.state } }
    public var rawEvents: [RawEvent] { get async { await abstractAgent.rawEvents } }
    public var customEvents: [CustomEvent] { get async { await abstractAgent.customEvents } }

    public func abortRun() async {
        await abstractAgent.abortRun()
    }

    public func dispose() async {
        await abstractAgent.dispose()
    }

    public func subscribe(_ subscriber: any AgentSubscriber) async -> any AgentSubscription {
        await abstractAgent.subscribe(subscriber)
    }
}
