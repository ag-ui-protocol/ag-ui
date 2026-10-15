import { describe, expect, it } from "vitest";
import { LangGraphAgent } from "./agent";
import { LangGraphEventTypes } from "./types";

class UsageAgent extends LangGraphAgent {
  usage() {
    return this.collectRunUsage();
  }
}

describe("V2 terminal model usage", () => {
  it("uses final output usage when chunks omit it, without counting streamed usage twice", () => {
    const agent = new UsageAgent({
      graphId: "test",
      deploymentUrl: "http://localhost:8000",
    });
    agent.activeRun = {
      id: "run",
      threadId: "thread",
      usage: [],
      textBlockMessageIds: new Map(),
      toolBlocks: new Map(),
      reasoningBlocks: new Map(),
    };
    const metadata = { ls_provider: "openai", ls_model_name: "gpt-4o" };
    const usage_metadata = {
      input_tokens: 11,
      output_tokens: 10,
      total_tokens: 21,
    };
    const end = (run_id: string) => ({
      event: LangGraphEventTypes.OnChatModelEnd,
      run_id,
      metadata,
      data: { output: { usage_metadata } },
    });
    agent.handleSingleEventV2(end("first"));
    expect(agent.usage()?.[0].totalTokens).toBe(21);
    agent.handleSingleEventV2({
      event: LangGraphEventTypes.OnChatModelStream,
      run_id: "second",
      metadata,
      data: {
        chunk: {
          usage_metadata,
          response_metadata: { finish_reason: "stop" },
        },
      },
    });
    agent.handleSingleEventV2(end("second"));
    expect(agent.usage()?.[0].totalTokens).toBe(42);
  });
});
