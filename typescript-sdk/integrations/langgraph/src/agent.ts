import { Observable, Subscriber } from "rxjs";
import {
  Client as LangGraphClient,
  EventsStreamEvent,
  StreamMode,
  Config as LangGraphConfig,
  ThreadState,
  Assistant,
  Message as LangGraphMessage,
  Config,
  Interrupt,
  Thread,
} from "@langchain/langgraph-sdk";
import { randomUUID } from "@ag-ui/client";
import {
  LangGraphPlatformMessage,
  CustomEventNames,
  LangGraphEventTypes,
  State,
  MessagesInProgressRecord,
  ThinkingInProgress,
  SchemaKeys,
  MessageInProgress,
  RunMetadata,
  PredictStateTool,
  LangGraphReasoning,
  StateEnrichment,
  LangGraphToolWithName,
} from "./types";
import {
  AbstractAgent,
  AgentConfig,
  CustomEvent,
  EventType,
  MessagesSnapshotEvent,
  RawEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageEndEvent,
  ThinkingStartEvent,
  ThinkingEndEvent,
} from "@ag-ui/client";
import { RunsStreamPayload } from "@langchain/langgraph-sdk/dist/types";
import {
  aguiMessagesToLangChain,
  DEFAULT_SCHEMA_KEYS,
  filterObjectBySchemaKeys,
  getStreamPayloadInput,
  langchainMessagesToAgui,
  resolveMessageContent,
  resolveReasoningContent,
} from "@/utils";

export type ProcessedEvents =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ThinkingTextMessageStartEvent
  | ThinkingTextMessageContentEvent
  | ThinkingTextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | ThinkingStartEvent
  | ThinkingEndEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | RawEvent
  | CustomEvent
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent;

type RunAgentExtendedInput<
  TStreamMode extends StreamMode | StreamMode[] = StreamMode,
  TSubgraphs extends boolean = false,
> = Omit<RunAgentInput, "forwardedProps"> & {
  forwardedProps?: Omit<RunsStreamPayload<TStreamMode, TSubgraphs>, "input"> & {
    nodeName?: string;
    threadMetadata?: Record<string, any>;
  };
};

interface RegenerateInput extends RunAgentExtendedInput {
  messageCheckpoint: LangGraphMessage;
}

export interface LangGraphAgentConfig extends AgentConfig {
  client?: LangGraphClient;
  deploymentUrl: string;
  langsmithApiKey?: string;
  propertyHeaders?: Record<string, string>;
  assistantConfig?: LangGraphConfig;
  agentName?: string;
  graphId: string;
}

export class LangGraphAgent extends AbstractAgent {
  client: LangGraphClient;
  assistantConfig?: LangGraphConfig;
  agentName?: string;
  graphId: string;
  assistant?: Assistant;
  messagesInProcess: MessagesInProgressRecord;
  thinkingProcess: null | ThinkingInProgress;
  activeRun?: RunMetadata;
  // @ts-expect-error no need to initialize subscriber right now
  subscriber: Subscriber<ProcessedEvents>;
  constantSchemaKeys: string[] = DEFAULT_SCHEMA_KEYS;
  config: LangGraphAgentConfig;

  constructor(config: LangGraphAgentConfig) {
    super(config);
    this.config = config;
    this.messagesInProcess = {};
    this.agentName = config.agentName;
    this.graphId = config.graphId;
    this.assistantConfig = config.assistantConfig;
    this.thinkingProcess = null;
    this.client =
      config?.client ??
      new LangGraphClient({
        apiUrl: config.deploymentUrl,
        apiKey: config.langsmithApiKey,
        defaultHeaders: { ...(config.propertyHeaders ?? {}) },
      });
  }

  public clone() {
    return new LangGraphAgent(this.config);
  }

  dispatchEvent(event: ProcessedEvents) {
    this.subscriber.next(event);
    return true;
  }

  run(input: RunAgentInput) {
    return new Observable<ProcessedEvents>((subscriber) => {
      this.runAgentStream(input, subscriber);
      return () => {};
    });
  }

  async runAgentStream(input: RunAgentExtendedInput, subscriber: Subscriber<ProcessedEvents>) {
    this.activeRun = {
      id: input.runId,
      threadId: input.threadId,
      hasFunctionStreaming: false,
    };
    this.subscriber = subscriber;
    if (!this.assistant) {
      this.assistant = await this.getAssistant();
    }
    const threadId = input.threadId ?? randomUUID();
    const streamMode =
      input.forwardedProps?.streamMode ?? (["events", "values", "updates"] satisfies StreamMode[]);
    const preparedStream = await this.prepareStream({ ...input, threadId }, streamMode);

    if (!preparedStream) {
      return subscriber.error("No stream to regenerate");
    }

    await this.handleStreamEvents(preparedStream, threadId, subscriber, input, Array.isArray(streamMode) ? streamMode : [streamMode]);
  }

  async prepareRegenerateStream(input: RegenerateInput, streamMode: StreamMode | StreamMode[]) {
    const { threadId, messageCheckpoint } = input;

    const timeTravelCheckpoint = await this.getCheckpointByMessage(
      messageCheckpoint!.id!,
      threadId,
    );
    if (!this.assistant) {
      this.assistant = await this.getAssistant();
    }

    if (!timeTravelCheckpoint) {
      return this.subscriber.error("No checkpoint found for message");
    }

    const fork = await this.client.threads.updateState(threadId, {
      values: this.langGraphDefaultMergeState(timeTravelCheckpoint.values, [], input),
      checkpointId: timeTravelCheckpoint.checkpoint.checkpoint_id!,
      asNode: timeTravelCheckpoint.next?.[0] ?? "__start__",
    });

    const payload = {
      ...(input.forwardedProps ?? {}),
      input: this.langGraphDefaultMergeState(
        timeTravelCheckpoint.values,
        [messageCheckpoint],
        input,
      ),
      // @ts-ignore
      checkpointId: fork.checkpoint.checkpoint_id!,
      streamMode,
    };
    return {
      streamResponse: this.client.runs.stream(threadId, this.assistant.assistant_id, payload),
      state: timeTravelCheckpoint as ThreadState<State>,
      streamMode,
    };
  }

  async prepareStream(input: RunAgentExtendedInput, streamMode: StreamMode | StreamMode[]) {
    let {
      threadId: inputThreadId,
      state: inputState,
      messages,
      tools,
      context,
      forwardedProps,
    } = input;
    // If a manual emittance happens, it is the ultimate source of truth of state, unless a node has exited.
    // Therefore, this value should either hold null, or the only edition of state that should be used.
    this.activeRun!.manuallyEmittedState = null;

    const nodeNameInput = forwardedProps?.nodeName;
    const threadId = inputThreadId ?? randomUUID();

    if (!this.assistant) {
      this.assistant = await this.getAssistant();
    }

    const thread = await this.getOrCreateThread(threadId, forwardedProps?.threadMetadata);
    this.activeRun!.threadId = thread.thread_id;

    const agentState: ThreadState<State> =
      (await this.client.threads.getState(thread.thread_id)) ??
      ({ values: {} } as ThreadState<State>);
    const agentStateMessages = agentState.values.messages ?? [];
    const inputMessagesToLangchain = aguiMessagesToLangChain(messages);
    const stateValuesDiff = this.langGraphDefaultMergeState(
      { ...inputState, messages: agentStateMessages },
      inputMessagesToLangchain,
      input,
    );
    // Messages are a combination of existing messages in state + everything that was newly sent
    let threadState = {
      ...agentState,
      values: {
        ...stateValuesDiff,
        messages: [...agentStateMessages, ...(stateValuesDiff.messages ?? [])],
      },
    };
    let stateValues = threadState.values;
    this.activeRun!.schemaKeys = await this.getSchemaKeys();

    if (
      (agentState.values.messages ?? []).length > messages.filter((m) => m.role !== "system").length
    ) {
      let lastUserMessage: LangGraphMessage | null = null;
      // Find the first user message by working backwards from the last message
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserMessage = aguiMessagesToLangChain([messages[i]])[0];
          break;
        }
      }

      if (!lastUserMessage) {
        return this.subscriber.error("No user message found in messages to regenerate");
      }

      return this.prepareRegenerateStream(
        { ...input, messageCheckpoint: lastUserMessage },
        streamMode,
      );
    }
    this.activeRun!.graphInfo = await this.client.assistants.getGraph(this.assistant.assistant_id);

    const mode =
      !forwardedProps?.command?.resume &&
      threadId &&
      this.activeRun!.nodeName != "__end__" &&
      this.activeRun!.nodeName
        ? "continue"
        : "start";

    if (mode === "continue") {
      const nodeBefore = this.activeRun!.graphInfo.edges.find(
        (e) => e.target === this.activeRun!.nodeName,
      );
      await this.client.threads.updateState(threadId, {
        values: inputState,
        asNode: nodeBefore?.source,
      });
    }

    const payloadInput = getStreamPayloadInput({
      mode,
      state: stateValues,
      schemaKeys: this.activeRun!.schemaKeys,
    });

    let payloadConfig: LangGraphConfig | undefined;
    const configsToMerge = [this.assistantConfig, forwardedProps?.config].filter(
      Boolean,
    ) as LangGraphConfig[];
    if (configsToMerge.length) {
      payloadConfig = await this.mergeConfigs({
        configs: configsToMerge,
        assistant: this.assistant,
        schemaKeys: this.activeRun!.schemaKeys,
      });
    }
    const payload = {
      ...forwardedProps,
      streamMode,
      input: payloadInput,
      config: payloadConfig,
      context: {
        ...context,
        ...(payloadConfig?.configurable ?? {}),
      }
    };

    // If there are still outstanding unresolved interrupts, we must force resolution of them before moving forward
    const interrupts = (agentState.tasks?.[0]?.interrupts ?? []) as Interrupt[];
    if (interrupts?.length && !forwardedProps?.command?.resume) {
      this.dispatchEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: input.runId,
      });
      this.handleNodeChange(nodeNameInput)

      interrupts.forEach((interrupt) => {
        this.dispatchEvent({
          type: EventType.CUSTOM,
          name: LangGraphEventTypes.OnInterrupt,
          value:
            typeof interrupt.value === "string" ? interrupt.value : JSON.stringify(interrupt.value),
          rawEvent: interrupt,
        });
      });

      this.dispatchEvent({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: input.runId,
      });
      return this.subscriber.complete();
    }

    return {
      // @ts-ignore
      streamResponse: this.client.runs.stream(threadId, this.assistant.assistant_id, payload),
      state: threadState as ThreadState<State>,
    };
  }

  async handleStreamEvents(
    stream: Awaited<
      ReturnType<typeof this.prepareStream> | ReturnType<typeof this.prepareRegenerateStream>
    >,
    threadId: string,
    subscriber: Subscriber<ProcessedEvents>,
    input: RunAgentExtendedInput,
    streamModes: StreamMode | StreamMode[],
  ) {
    const { forwardedProps } = input;
    const nodeNameInput = forwardedProps?.nodeName;
    this.subscriber = subscriber;
    let shouldExit = false;
    if (!stream) return;

    let { streamResponse, state } = stream;

    this.activeRun!.prevNodeName = null;
    let latestStateValues = {} as ThreadState<State>["values"];
    let updatedState = state;

    try {
      this.dispatchEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: this.activeRun!.id,
      });
      this.handleNodeChange(nodeNameInput)

      for await (let streamResponseChunk of streamResponse) {
        const subgraphsStreamEnabled = input.forwardedProps?.streamSubgraphs;
        const isSubgraphStream =
          subgraphsStreamEnabled &&
          (streamResponseChunk.event.startsWith("events") ||
            streamResponseChunk.event.startsWith("values"));

        // @ts-ignore
        if (!streamModes.includes(streamResponseChunk.event as StreamMode) && !isSubgraphStream && streamResponseChunk.event !== 'error') {
          continue;
        }

        // Force event type, as data is not properly defined on the LG side.
        type EventsChunkData = {
          __interrupt__?: any;
          metadata: Record<string, any>;
          event: string;
          data: any;
          [key: string]: unknown;
        };
        const chunk = streamResponseChunk as EventsStreamEvent & { data: EventsChunkData };

        if (streamResponseChunk.event === "error") {
          this.dispatchEvent({
            type: EventType.RUN_ERROR,
            message: streamResponseChunk.data.message,
            rawEvent: streamResponseChunk,
          });
          break;
        }

        if (streamResponseChunk.event === "updates") {
          continue;
        }

        if (streamResponseChunk.event === "values") {
          latestStateValues = chunk.data;
          continue;
        } else if (subgraphsStreamEnabled && chunk.event.startsWith("values|")) {
          latestStateValues = {
            ...latestStateValues,
            ...chunk.data,
          };
          continue;
        }

        const chunkData = chunk.data;
        const metadata = chunkData.metadata ?? {};
        const currentNodeName = metadata.langgraph_node;
        const eventType = chunkData.event;

        this.activeRun!.id = metadata.run_id;

        if (currentNodeName && currentNodeName !== this.activeRun!.nodeName) {
          this.handleNodeChange(currentNodeName)
        }

        shouldExit =
          shouldExit ||
          (eventType === LangGraphEventTypes.OnCustomEvent &&
            chunkData.name === CustomEventNames.Exit);

        this.activeRun!.exitingNode =
          this.activeRun!.nodeName === currentNodeName &&
          eventType === LangGraphEventTypes.OnChainEnd;
        if (this.activeRun!.exitingNode) {
          this.activeRun!.manuallyEmittedState = null;
        }

        // we only want to update the node name under certain conditions
        // since we don't need any internal node names to be sent to the frontend
        if (this.activeRun!.graphInfo?.["nodes"].some((node) => node.id === currentNodeName)) {
          this.handleNodeChange(currentNodeName)
        }

        updatedState.values = this.activeRun!.manuallyEmittedState ?? latestStateValues;

        if (!this.activeRun!.nodeName) {
          continue;
        }

        const hasStateDiff = JSON.stringify(updatedState) !== JSON.stringify(state);
        // We should not update snapshot while a message is in progress.
        if (
          (hasStateDiff ||
            this.activeRun!.prevNodeName != this.activeRun!.nodeName ||
            this.activeRun!.exitingNode) &&
          !Boolean(this.getMessageInProgress(this.activeRun!.id))
        ) {
          state = updatedState;
          this.activeRun!.prevNodeName = this.activeRun!.nodeName;

          this.dispatchEvent({
            type: EventType.STATE_SNAPSHOT,
            snapshot: this.getStateSnapshot(state),
            rawEvent: chunk,
          });
        }

        this.dispatchEvent({
          type: EventType.RAW,
          event: chunkData,
        });

        this.handleSingleEvent(chunkData);
      }

      state = await this.client.threads.getState(threadId);
      const tasks = state.tasks;
      const interrupts = (tasks?.[0]?.interrupts ?? []) as Interrupt[];
      const isEndNode = state.next.length === 0;
      const writes = state.metadata?.writes ?? {};

      // Initialize a new node name to use in the next if block
      let newNodeName = this.activeRun!.nodeName!;

      if (!interrupts?.length) {
        newNodeName = isEndNode ? "__end__" : (state.next[0] ?? Object.keys(writes)[0]);
      }

      interrupts.forEach((interrupt) => {
        this.dispatchEvent({
          type: EventType.CUSTOM,
          name: LangGraphEventTypes.OnInterrupt,
          value:
            typeof interrupt.value === "string" ? interrupt.value : JSON.stringify(interrupt.value),
          rawEvent: interrupt,
        });
      });

      this.handleNodeChange(newNodeName);
      // Immediately turn off new step
      this.handleNodeChange(undefined);

      this.dispatchEvent({
        type: EventType.STATE_SNAPSHOT,
        snapshot: this.getStateSnapshot(state),
      });
      this.dispatchEvent({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: langchainMessagesToAgui((state.values as { messages: any[] }).messages ?? []),
      });

      this.dispatchEvent({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: this.activeRun!.id,
      });
      this.activeRun = undefined;
      return subscriber.complete();
    } catch (e) {
      return subscriber.error(e);
    }
  }

  handleSingleEvent(event: any): void {
    switch (event.event) {
      case LangGraphEventTypes.OnChatModelStream:
        let shouldEmitMessages = event.metadata["emit-messages"] ?? true;
        let shouldEmitToolCalls = event.metadata["emit-tool-calls"] ?? true;

        if (event.data.chunk.response_metadata.finish_reason) return;
        let currentStream = this.getMessageInProgress(this.activeRun!.id);
        const hasCurrentStream = Boolean(currentStream?.id);
        const toolCallData = event.data.chunk.tool_call_chunks?.[0];
        const toolCallUsedToPredictState = event.metadata["predict_state"]?.some(
          (predictStateTool: PredictStateTool) => predictStateTool.tool === toolCallData?.name,
        );

        const isToolCallStartEvent = !hasCurrentStream && toolCallData?.name;
        const isToolCallArgsEvent =
          hasCurrentStream && currentStream?.toolCallId && toolCallData?.args;
        const isToolCallEndEvent = hasCurrentStream && currentStream?.toolCallId && !toolCallData;

        if (isToolCallEndEvent || isToolCallArgsEvent || isToolCallStartEvent) {
          this.activeRun!.hasFunctionStreaming = true;
        }

        const reasoningData = resolveReasoningContent(event.data);
        const messageContent = resolveMessageContent(event.data.chunk.content);
        const isMessageContentEvent = Boolean(!toolCallData && messageContent);

        const isMessageEndEvent =
          hasCurrentStream && !currentStream?.toolCallId && !isMessageContentEvent;

        if (reasoningData) {
          this.handleThinkingEvent(reasoningData);
          break;
        }

        if (!reasoningData && this.thinkingProcess) {
          this.dispatchEvent({
            type: EventType.THINKING_TEXT_MESSAGE_END,
          });
          this.dispatchEvent({
            type: EventType.THINKING_END,
          });
          this.thinkingProcess = null;
        }

        if (toolCallUsedToPredictState) {
          this.dispatchEvent({
            type: EventType.CUSTOM,
            name: "PredictState",
            value: event.metadata["predict_state"],
          });
        }

        if (isToolCallEndEvent) {
          const resolved = this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: currentStream?.toolCallId!,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }

        if (isMessageEndEvent) {
          const resolved = this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentStream!.id,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }

        if (isToolCallStartEvent && shouldEmitToolCalls) {
          const resolved = this.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId: toolCallData.id,
            toolCallName: toolCallData.name,
            parentMessageId: event.data.chunk.id,
            rawEvent: event,
          });
          if (resolved) {
            this.setMessageInProgress(this.activeRun!.id, {
              id: event.data.chunk.id,
              toolCallId: toolCallData.id,
              toolCallName: toolCallData.name,
            });
          }
          break;
        }

        // Tool call args: emit ActionExecutionArgs
        if (isToolCallArgsEvent && shouldEmitToolCalls) {
          this.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: currentStream?.toolCallId!,
            delta: toolCallData.args,
            rawEvent: event,
          });
          break;
        }

        // Message content: emit TextMessageContent
        if (isMessageContentEvent && shouldEmitMessages) {
          // No existing message yet, also init the message
          if (!currentStream) {
            this.dispatchEvent({
              type: EventType.TEXT_MESSAGE_START,
              role: "assistant",
              messageId: event.data.chunk.id,
              rawEvent: event,
            });
            this.setMessageInProgress(this.activeRun!.id, {
              id: event.data.chunk.id,
              toolCallId: null,
              toolCallName: null,
            });
            currentStream = this.getMessageInProgress(this.activeRun!.id);
          }

          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: currentStream!.id,
            delta: messageContent!,
            rawEvent: event,
          });
          break;
        }

        break;
      case LangGraphEventTypes.OnChatModelEnd:
        if (this.getMessageInProgress(this.activeRun!.id)?.toolCallId) {
          const resolved = this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: this.getMessageInProgress(this.activeRun!.id)!.toolCallId!,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }
        if (this.getMessageInProgress(this.activeRun!.id)?.id) {
          const resolved = this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: this.getMessageInProgress(this.activeRun!.id)!.id,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }
        break;
      case LangGraphEventTypes.OnCustomEvent:
        if (event.name === CustomEventNames.ManuallyEmitMessage) {
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_START,
            role: "assistant",
            messageId: event.data.message_id,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: event.data.message_id,
            delta: event.data.message,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: event.data.message_id,
            rawEvent: event,
          });
          break;
        }

        if (event.name === CustomEventNames.ManuallyEmitToolCall) {
          this.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId: event.data.id,
            toolCallName: event.data.name,
            parentMessageId: event.data.id,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: event.data.id,
            delta: event.data.args,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: event.data.id,
            rawEvent: event,
          });
          break;
        }

        if (event.name === CustomEventNames.ManuallyEmitState) {
          this.activeRun!.manuallyEmittedState = event.data;
          this.dispatchEvent({
            type: EventType.STATE_SNAPSHOT,
            snapshot: this.getStateSnapshot({
              values: this.activeRun!.manuallyEmittedState!,
            } as ThreadState<State>),
            rawEvent: event,
          });
        }

        this.dispatchEvent({
          type: EventType.CUSTOM,
          name: event.name,
          value: event.data,
          rawEvent: event,
        });
        break;
      case LangGraphEventTypes.OnToolEnd:
        const toolCallOutput = event.data?.output
        if (!this.activeRun!.hasFunctionStreaming) {
          this.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId: toolCallOutput.tool_call_id,
            toolCallName: toolCallOutput.name,
            parentMessageId: toolCallOutput.id,
            rawEvent: event,
          })
          this.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: toolCallOutput.tool_call_id,
            delta: JSON.stringify(event.data.input),
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: toolCallOutput.tool_call_id,
            rawEvent: event,
          });
        }
        this.dispatchEvent({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: toolCallOutput.tool_call_id,
          content: toolCallOutput?.content,
          messageId: randomUUID(),
          role: "tool",
        })
        break;
    }
  }

  handleThinkingEvent(reasoningData: LangGraphReasoning) {
    if (!reasoningData || !reasoningData.type || !reasoningData.text) {
      return;
    }

    const thinkingStepIndex = reasoningData.index;

    if (this.thinkingProcess?.index && this.thinkingProcess.index !== thinkingStepIndex) {
      if (this.thinkingProcess.type) {
        this.dispatchEvent({
          type: EventType.THINKING_TEXT_MESSAGE_END,
        });
      }
      this.dispatchEvent({
        type: EventType.THINKING_END,
      });
      this.thinkingProcess = null;
    }

    if (!this.thinkingProcess) {
      // No thinking step yet. Start a new one
      this.dispatchEvent({
        type: EventType.THINKING_START,
      });
      this.thinkingProcess = {
        index: thinkingStepIndex,
      };
    }

    if (this.thinkingProcess.type !== reasoningData.type) {
      this.dispatchEvent({
        type: EventType.THINKING_TEXT_MESSAGE_START,
      });
      this.thinkingProcess.type = reasoningData.type;
    }

    if (this.thinkingProcess.type) {
      this.dispatchEvent({
        type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
        delta: reasoningData.text,
      });
    }
  }

  getStateSnapshot(threadState: ThreadState<State>) {
    let state = threadState.values;
    const schemaKeys = this.activeRun!.schemaKeys!;
    // Do not emit state keys that are not part of the output schema
    if (schemaKeys?.output) {
      state = filterObjectBySchemaKeys(state, [...this.constantSchemaKeys, ...schemaKeys.output]);
    }
    // return state
    return state;
  }

  async getOrCreateThread(threadId: string, threadMetadata?: Record<string, any>): Promise<Thread> {
    let thread: Thread;
    try {
      try {
        thread = await this.getThread(threadId);
      } catch (error) {
        thread = await this.createThread({
          threadId,
          metadata: threadMetadata,
        });
      }
    } catch (error: unknown) {
      throw new Error(`Failed to create thread: ${(error as Error).message}`);
    }

    return thread;
  }

  async getThread(threadId: string) {
    return this.client.threads.get(threadId);
  }

  async createThread(payload?: Parameters<typeof this.client.threads.create>[0]) {
    return this.client.threads.create(payload);
  }

  async mergeConfigs({
    configs,
    assistant,
    schemaKeys,
  }: {
    configs: Config[];
    assistant: Assistant;
    schemaKeys: SchemaKeys;
  }) {
    return configs.reduce((acc, cfg) => {
      let filteredConfigurable = acc.configurable;

      if (cfg.configurable) {
        filteredConfigurable = schemaKeys?.config
          ? filterObjectBySchemaKeys(cfg?.configurable, [
              ...this.constantSchemaKeys,
              ...(schemaKeys?.config ?? []),
            ])
          : cfg?.configurable;
      }

      const newConfig = {
        ...acc,
        ...cfg,
        configurable: filteredConfigurable,
      };

      // LG does not return recursion limit if it's the default, therefore we check: if no recursion limit is currently set, and the user asked for 25, there is no change.
      const isRecursionLimitSetToDefault =
        acc.recursion_limit == null && cfg.recursion_limit === 25;
      // Deep compare configs to avoid unnecessary update calls
      const configsAreDifferent = JSON.stringify(newConfig) !== JSON.stringify(acc);

      // Check if the only difference is the recursion_limit being set to default
      const isOnlyRecursionLimitDifferent =
        isRecursionLimitSetToDefault &&
        JSON.stringify({ ...newConfig, recursion_limit: null }) ===
          JSON.stringify({ ...acc, recursion_limit: null });

      if (configsAreDifferent && !isOnlyRecursionLimitDifferent) {
        return {
          ...acc,
          ...newConfig,
        };
      }

      return acc;
    }, assistant.config);
  }

  getMessageInProgress(runId: string) {
    return this.messagesInProcess[runId];
  }

  setMessageInProgress(runId: string, data: MessageInProgress) {
    this.messagesInProcess = {
      ...this.messagesInProcess,
      [runId]: {
        ...(this.messagesInProcess[runId] as MessageInProgress),
        ...data,
      },
    };
  }

  async getAssistant(): Promise<Assistant> {
    const assistants = await this.client.assistants.search();
    const retrievedAssistant = assistants.find(
      (searchResult) => searchResult.graph_id === this.graphId,
    );
    if (!retrievedAssistant) {
      console.error(`
      No agent found with graph ID ${this.graphId} found..\n

      These are the available agents: [${assistants.map((a) => `${a.graph_id} (ID: ${a.assistant_id})`).join(", ")}]
      `);
      throw new Error("No agent id found");
    }

    return retrievedAssistant;
  }

  async getSchemaKeys(): Promise<SchemaKeys> {
    try {
      const graphSchema = await this.client.assistants.getSchemas(this.assistant!.assistant_id);
      let configSchema = null;
      let contextSchema: string[] = []
      if ('context_schema' in graphSchema && graphSchema.context_schema?.properties) {
        contextSchema = Object.keys(graphSchema.context_schema.properties);
      }
      if (graphSchema.config_schema?.properties) {
        configSchema = Object.keys(graphSchema.config_schema.properties);
      }
      if (!graphSchema.input_schema?.properties || !graphSchema.output_schema?.properties) {
        return { config: [], input: null, output: null, context: contextSchema };
      }
      const inputSchema = Object.keys(graphSchema.input_schema.properties);
      const outputSchema = Object.keys(graphSchema.output_schema.properties);

      return {
        input:
          inputSchema && inputSchema.length ? [...inputSchema, ...this.constantSchemaKeys] : null,
        output:
          outputSchema && outputSchema.length
            ? [...outputSchema, ...this.constantSchemaKeys]
            : null,
        context: contextSchema,
        config: configSchema,
      };
    } catch (e) {
      return { config: [], input: this.constantSchemaKeys, output: this.constantSchemaKeys, context: [] };
    }
  }

  langGraphDefaultMergeState(state: State, messages: LangGraphMessage[], input: RunAgentExtendedInput): State<StateEnrichment> {
    if (messages.length > 0 && "role" in messages[0] && messages[0].role === "system") {
      // remove system message
      messages = messages.slice(1);
    }

    // merge with existing messages
    const existingMessages: LangGraphPlatformMessage[] = state.messages || [];
    const existingMessageIds = new Set(existingMessages.map((message) => message.id));

    const newMessages = messages.filter((message) => !existingMessageIds.has(message.id));

    const langGraphTools: LangGraphToolWithName[] = [...(state.tools ?? []), ...(input.tools ?? [])].reduce((acc, tool) => {
      let mappedTool = tool;
      if (!tool.type) {
        mappedTool = {
            type: "function",
            name: tool.name,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }
      }

      // Verify no duplicated
      if (acc.find((t: LangGraphToolWithName) => (t.name === mappedTool.name) || t.function.name === mappedTool.function.name)) return acc;

      return [...acc, mappedTool];
    }, []);

    return {
      ...state,
      messages: newMessages,
      tools: langGraphTools,
      'ag-ui': {
        tools: langGraphTools,
        context: input.context,
      }
    };
  }

  handleNodeChange(nodeName: string | undefined) {
    if (nodeName === "__end__") {
      nodeName = undefined;
    }
    if (nodeName !== this.activeRun?.nodeName) {
      // End current step
      if (this.activeRun?.nodeName) {
        this.endStep();
      }
      // If we actually got a node name, start a new step
      if (nodeName) {
        this.startStep(nodeName);
      }
    }
    this.activeRun!.nodeName = nodeName;
  }

  startStep(nodeName: string) {
    this.dispatchEvent({
      type: EventType.STEP_STARTED,
      stepName: nodeName,
    });
  }

  endStep() {
    this.dispatchEvent({
      type: EventType.STEP_FINISHED,
      stepName: this.activeRun!.nodeName!,
    });
  }

  async getCheckpointByMessage(
    messageId: string,
    threadId: string,
    checkpoint?: null | {
      checkpoint_id?: null | string;
      checkpoint_ns: string;
    },
  ): Promise<ThreadState> {
    const options = checkpoint?.checkpoint_id
      ? {
          checkpoint: { checkpoint_id: checkpoint.checkpoint_id },
        }
      : undefined;
    const history = await this.client.threads.getHistory(threadId, options);
    const reversed = [...history].reverse(); // oldest → newest

    let targetState = reversed.find((state) =>
      (state.values as State).messages?.some((m: LangGraphPlatformMessage) => m.id === messageId),
    );

    if (!targetState) throw new Error("Message not found");

    const targetStateMessages = (targetState.values as State).messages ?? [];
    const messageIndex = targetStateMessages.findIndex(
      (m: LangGraphPlatformMessage) => m.id === messageId,
    );
    const messagesAfter = targetStateMessages.slice(messageIndex + 1);
    if (messagesAfter.length) {
      return this.getCheckpointByMessage(messageId, threadId, targetState.parent_checkpoint);
    }

    const targetStateIndex = reversed.indexOf(targetState);

    const { messages, ...targetStateValuesWithoutMessages } = targetState.values as State;
    const selectedCheckpoint = reversed[targetStateIndex - 1] ?? { ...targetState, values: {} };
    return {
      ...selectedCheckpoint,
      values: { ...selectedCheckpoint.values, ...targetStateValuesWithoutMessages },
    };
  }
}

export * from "./types";
