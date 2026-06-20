import { describe, it, expect } from "vitest";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  makeInput,
  collectEvents,
} from "./helpers";
import { MastraAgent } from "../mastra";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextChunks() {
  return [
    { type: "text-delta", payload: { text: "Hello" } },
    { type: "finish", payload: {} },
  ];
}

function makeLocalAgentCapturingStream(streamChunks: any[]) {
  const fakeAgent = new FakeLocalAgent({ streamChunks });
  const streamCalls: Array<{ messages: any; opts: any }> = [];

  const originalStream = fakeAgent.stream.bind(fakeAgent);
  fakeAgent.stream = async (messages: any, opts?: any) => {
    streamCalls.push({ messages, opts });
    return originalStream(messages, opts);
  };

  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
  });

  return { agent, fakeAgent, streamCalls };
}

function makeRemoteAgentCapturingStream(streamChunks: any[]) {
  const fakeAgent = new FakeRemoteAgent({ streamChunks });
  const streamCalls: Array<{ messages: any; opts: any }> = [];

  const originalStream = fakeAgent.stream.bind(fakeAgent);
  fakeAgent.stream = async (messages: any, opts?: any) => {
    streamCalls.push({ messages, opts });
    return originalStream(messages, opts);
  };

  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
  });

  return { agent, fakeAgent, streamCalls };
}

function makeLocalAgentCapturingResumeStream(resumeChunks: any[]) {
  const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
  const resumeCalls: Array<{ resumeData: any; opts: any }> = [];

  (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
    resumeCalls.push({ resumeData, opts });
    return {
      fullStream: (async function* () {
        for (const chunk of resumeChunks) yield chunk;
      })(),
    };
  };

  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
  });

  return { agent, fakeAgent, resumeCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("header forwarding", () => {
  describe("stream() - local agent", () => {
    it("forwards headers via modelSettings.headers when set", async () => {
      const { agent, streamCalls } =
        makeLocalAgentCapturingStream(makeTextChunks());
      agent.headers = { "x-aimock-context": "test", "x-test-id": "abc" };

      await collectEvents(
        agent,
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      expect(streamCalls).toHaveLength(1);
      const opts = streamCalls[0].opts;
      expect(opts.modelSettings).toBeDefined();
      expect(opts.modelSettings.headers).toEqual({
        "x-aimock-context": "test",
        "x-test-id": "abc",
      });
    });

    it("does not include modelSettings when headers is undefined", async () => {
      const { agent, streamCalls } =
        makeLocalAgentCapturingStream(makeTextChunks());
      // headers is undefined by default

      await collectEvents(
        agent,
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      expect(streamCalls).toHaveLength(1);
      const opts = streamCalls[0].opts;
      expect(opts.modelSettings).toBeUndefined();
    });

    it("does not include modelSettings when headers is empty object", async () => {
      const { agent, streamCalls } =
        makeLocalAgentCapturingStream(makeTextChunks());
      agent.headers = {};

      await collectEvents(
        agent,
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      expect(streamCalls).toHaveLength(1);
      const opts = streamCalls[0].opts;
      expect(opts.modelSettings).toBeUndefined();
    });

    it("preserves existing stream options alongside modelSettings", async () => {
      const { agent, streamCalls } =
        makeLocalAgentCapturingStream(makeTextChunks());
      agent.headers = { "x-aimock-context": "test" };

      await collectEvents(
        agent,
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      expect(streamCalls).toHaveLength(1);
      const opts = streamCalls[0].opts;
      // Existing options are preserved
      expect(opts.memory).toBeDefined();
      expect(opts.runId).toBeDefined();
      expect(opts.clientTools).toBeDefined();
      // Headers injected via modelSettings
      expect(opts.modelSettings.headers).toEqual({
        "x-aimock-context": "test",
      });
    });
  });

  describe("stream() - remote agent", () => {
    it("forwards headers via modelSettings.headers when set", async () => {
      const { agent, streamCalls } =
        makeRemoteAgentCapturingStream(makeTextChunks());
      agent.headers = { "x-aimock-context": "remote-test" };

      await collectEvents(
        agent,
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      expect(streamCalls).toHaveLength(1);
      const opts = streamCalls[0].opts;
      expect(opts.modelSettings).toBeDefined();
      expect(opts.modelSettings.headers).toEqual({
        "x-aimock-context": "remote-test",
      });
    });

    it("does not include modelSettings when headers is undefined", async () => {
      const { agent, streamCalls } =
        makeRemoteAgentCapturingStream(makeTextChunks());

      await collectEvents(
        agent,
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      expect(streamCalls).toHaveLength(1);
      const opts = streamCalls[0].opts;
      expect(opts.modelSettings).toBeUndefined();
    });
  });

  describe("clone()", () => {
    it("preserves headers across clone()", () => {
      const { agent } = makeLocalAgentCapturingStream(makeTextChunks());
      agent.headers = {
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      };

      const cloned = agent.clone() as MastraAgent;

      expect(cloned.headers).toEqual({
        "x-aimock-context": "test-clone",
        "x-test-id": "clone-123",
      });
    });

    it("creates a defensive copy (mutating clone does not affect original)", () => {
      const { agent } = makeLocalAgentCapturingStream(makeTextChunks());
      agent.headers = { "x-aimock-context": "original" };

      const cloned = agent.clone() as MastraAgent;
      cloned.headers!["x-aimock-context"] = "mutated";
      cloned.headers!["x-new"] = "added";

      expect(agent.headers).toEqual({ "x-aimock-context": "original" });
      expect(cloned.headers).not.toBe(agent.headers);
    });

    it("leaves headers undefined on clone when not set on original", () => {
      const { agent } = makeLocalAgentCapturingStream(makeTextChunks());
      // headers is undefined by default

      const cloned = agent.clone() as MastraAgent;

      expect(cloned.headers).toBeUndefined();
    });
  });

  describe("resumeStream()", () => {
    const resumeTextChunks = [
      { type: "text-delta", payload: { text: "Resumed response" } },
      { type: "finish", payload: {} },
    ];

    it("forwards headers via modelSettings.headers on resumeStream", async () => {
      const { agent, resumeCalls } =
        makeLocalAgentCapturingResumeStream(resumeTextChunks);
      agent.headers = { "x-aimock-context": "resume-test" };

      const input = makeInput({
        forwardedProps: {
          command: {
            resume: { approved: true },
            interruptEvent: JSON.stringify({
              toolCallId: "tc-1",
              runId: "run-1",
            }),
          },
        },
      });

      await collectEvents(agent, input);

      expect(resumeCalls).toHaveLength(1);
      const opts = resumeCalls[0].opts;
      expect(opts.modelSettings).toBeDefined();
      expect(opts.modelSettings.headers).toEqual({
        "x-aimock-context": "resume-test",
      });
    });

    it("does not include modelSettings on resumeStream when headers is undefined", async () => {
      const { agent, resumeCalls } =
        makeLocalAgentCapturingResumeStream(resumeTextChunks);
      // headers is undefined by default

      const input = makeInput({
        forwardedProps: {
          command: {
            resume: { approved: true },
            interruptEvent: JSON.stringify({
              toolCallId: "tc-1",
              runId: "run-1",
            }),
          },
        },
      });

      await collectEvents(agent, input);

      expect(resumeCalls).toHaveLength(1);
      const opts = resumeCalls[0].opts;
      expect(opts.modelSettings).toBeUndefined();
    });

    it("does not include modelSettings on resumeStream when headers is empty", async () => {
      const { agent, resumeCalls } =
        makeLocalAgentCapturingResumeStream(resumeTextChunks);
      agent.headers = {};

      const input = makeInput({
        forwardedProps: {
          command: {
            resume: { approved: true },
            interruptEvent: JSON.stringify({
              toolCallId: "tc-1",
              runId: "run-1",
            }),
          },
        },
      });

      await collectEvents(agent, input);

      expect(resumeCalls).toHaveLength(1);
      const opts = resumeCalls[0].opts;
      expect(opts.modelSettings).toBeUndefined();
    });

    it("preserves existing resumeStream options alongside modelSettings", async () => {
      const { agent, resumeCalls } =
        makeLocalAgentCapturingResumeStream(resumeTextChunks);
      agent.headers = { "x-test-id": "preserve-test" };

      const input = makeInput({
        forwardedProps: {
          command: {
            resume: { approved: true },
            interruptEvent: JSON.stringify({
              toolCallId: "tc-1",
              runId: "run-1",
            }),
          },
        },
      });

      await collectEvents(agent, input);

      expect(resumeCalls).toHaveLength(1);
      const opts = resumeCalls[0].opts;
      // Existing resume options are preserved
      expect(opts.toolCallId).toBe("tc-1");
      expect(opts.runId).toBe("run-1");
      expect(opts.memory).toBeDefined();
      expect(opts.requestContext).toBeDefined();
      // Headers injected via modelSettings
      expect(opts.modelSettings.headers).toEqual({
        "x-test-id": "preserve-test",
      });
    });
  });
});
