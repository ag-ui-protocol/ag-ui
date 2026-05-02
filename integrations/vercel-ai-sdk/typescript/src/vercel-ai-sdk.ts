// Main agent class. Wires AI SDK v6 streamText into AG-UI by:
//   1. converting input messages/tools to AI SDK shapes
//   2. driving streamText() with abort propagation
//   3. delegating fullStream → AG-UI event mapping to StreamHandler
//
// StreamHandler owns the full RUN_STARTED → RUN_FINISHED lifecycle, so this
// class only sets up the pipe and tears it down on unsubscribe.

import {
  AbstractAgent,
  type AgentConfig,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  streamText,
  stepCountIs,
  type LanguageModel,
  type ToolChoice,
} from "ai";
import { Observable } from "rxjs";
import { convertMessagesToVercelAISDKMessages } from "./message-converter";
import { convertToolsToVercelAISDKTools } from "./tool-converter";
import { StreamHandler } from "./stream-handler";

export interface VercelAISDKAgentConfig extends AgentConfig {
  model: LanguageModel;
  maxSteps?: number;
  toolChoice?: ToolChoice<Record<string, unknown>>;
}

export class VercelAISDKAgent extends AbstractAgent {
  model: LanguageModel;
  maxSteps: number;
  toolChoice: ToolChoice<Record<string, unknown>>;

  constructor(private config: VercelAISDKAgentConfig) {
    const { model, maxSteps, toolChoice, ...rest } = config;
    super(rest);
    this.model = model;
    this.maxSteps = maxSteps ?? 1;
    this.toolChoice = toolChoice ?? "auto";
  }

  public clone() {
    return new VercelAISDKAgent(this.config);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const abortController = new AbortController();

      const result = streamText({
        model: this.model,
        messages: convertMessagesToVercelAISDKMessages(input.messages),
        tools: convertToolsToVercelAISDKTools(input.tools),
        stopWhen: stepCountIs(this.maxSteps),
        toolChoice: this.toolChoice,
        abortSignal: abortController.signal,
      });

      const handler = new StreamHandler(input, subscriber);
      void handler.process(result.fullStream);

      return () => {
        abortController.abort();
      };
    });
  }
}
