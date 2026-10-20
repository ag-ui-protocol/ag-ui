import { describe, it, expect, vi } from "vitest";

// Mock workspace packages that aren't built in worktree isolation
vi.mock("@ag-ui/client", () => {
  class AbstractAgent {
    constructor(_config?: Record<string, unknown>) {}
  }
  return {
    AbstractAgent,
    EventType: {},
    randomUUID: () => crypto.randomUUID(),
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
}));

vi.mock("@anthropic-ai/sdk/resources/beta/messages/messages", () => ({}));

import { ClaudeAgentAdapter } from "./adapter";

const input = { threadId: "t1", runId: "r1", messages: [], tools: [], context: [] };

describe("ClaudeAgentAdapter.buildOptions settingSources", () => {
  it("loads no filesystem settings by default", () => {
    // The SDK loads ~/.claude settings and the working directory's CLAUDE.md
    // when settingSources is omitted; the adapter keeps runs isolated.
    const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
    expect(adapter.buildOptions(input).settingSources).toEqual([]);
  });

  it("keeps the caller's settingSources", () => {
    const adapter = new ClaudeAgentAdapter({
      model: "claude-haiku-4-5",
      settingSources: ["project"],
    });
    expect(adapter.buildOptions(input).settingSources).toEqual(["project"]);
  });
});
