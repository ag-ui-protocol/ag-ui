// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import AGUITools
import Foundation

public final class AgUiAgent: Sendable {

    // MARK: - Public properties

    public let config: AgUiAgentConfig

    // MARK: - Private state

    private let transport: any AgentTransport
    private let httpAgent: HttpAgent
    private let toolExecutionManager: ToolExecutionManager?

    // MARK: - Initialization

    public init(
        url: URL,
        configure: (inout AgUiAgentConfig) -> Void = { _ in }
    ) {
        var cfg = AgUiAgentConfig()
        configure(&cfg)
        self.config = cfg

        var httpConfig = HttpAgentConfiguration(baseURL: url)
        httpConfig.timeout = cfg.requestTimeout
        httpConfig.retryPolicy = cfg.retryPolicy
        httpConfig.headers = cfg.buildHeaders()

        let agent = HttpAgent(configuration: httpConfig)
        self.httpAgent = agent
        self.transport = HttpAgentTransport(configuration: httpConfig)

        if let registry = cfg.toolRegistry {
            self.toolExecutionManager = ToolExecutionManager(
                toolRegistry: registry,
                responseHandler: ClientToolResponseHandler(httpAgent: agent)
            )
        } else {
            self.toolExecutionManager = nil
        }
    }

    public init(
        transport: any AgentTransport,
        config: AgUiAgentConfig = AgUiAgentConfig(),
        toolExecutionManager: ToolExecutionManager? = nil
    ) {
        self.config = config
        self.transport = transport
        let url = URL(string: "https://placeholder.local")!
        self.httpAgent = HttpAgent(baseURL: url)
        self.toolExecutionManager = toolExecutionManager
    }

    // MARK: - Core run method

    public func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        transport.run(input: input)
    }

    // MARK: - sendMessage (primary API)

    public func sendMessage(
        _ message: String,
        threadId: String = UUID().uuidString,
        state: State? = nil,
        includeSystemPrompt: Bool = true
    ) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var messages: [any Message] = []

                    if includeSystemPrompt, let prompt = self.config.systemPrompt {
                        messages.append(SystemMessage(
                            id: "sys_\(UUID().uuidString)",
                            content: prompt
                        ))
                    }

                    messages.append(UserMessage(
                        id: "usr_\(UUID().uuidString)",
                        content: message
                    ))

                    var tools: [Tool] = []
                    if let registry = self.config.toolRegistry {
                        tools = await registry.allTools()
                    }

                    let input = RunAgentInput(
                        threadId: threadId,
                        runId: "run_\(UUID().uuidString)",
                        state: state ?? Data("{}".utf8),
                        messages: messages,
                        tools: tools,
                        context: self.config.context,
                        forwardedProps: self.config.forwardedProps
                    )

                    let rawStream = self.run(input: input)

                    if let manager = self.toolExecutionManager {
                        let managed = await manager.processEventStream(
                            rawStream,
                            threadId: input.threadId,
                            runId: input.runId
                        )
                        for try await event in managed {
                            continuation.yield(event)
                        }
                    } else {
                        for try await event in rawStream {
                            continuation.yield(event)
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Subscriber

    public func subscribe(_ subscriber: any AgentSubscriber) async -> any AgentSubscription {
        await httpAgent.subscribe(subscriber)
    }

    // MARK: - Lifecycle

    public func close() async {
        if let manager = toolExecutionManager {
            await manager.cancelAllExecutions()
        }
        await httpAgent.dispose()
    }
}
