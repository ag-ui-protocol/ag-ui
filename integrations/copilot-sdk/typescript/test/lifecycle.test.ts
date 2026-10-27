import { describe, expect, it } from "vitest";
import { CopilotAgent } from "../src/index.js";
import { FakeClient, FRONTEND_TOOL_TURN, TEXT_TURN, TOOLS, makeInput, run } from "./helpers.js";

describe("session lifecycle", () => {
  it("L1+L2: resumes the native session after a failed run, despite resolved tool messages", async () => {
    const script = [...FRONTEND_TOOL_TURN];
    const client = new FakeClient(script);
    const agent = new CopilotAgent({ client, runTimeoutMs: 200 });
    const transcript = makeInput({
      tools: TOOLS,
      messages: [
        ...makeInput().messages,
        { id: "result", role: "tool", toolCallId: "call-1", content: "ok" },
      ],
    });
    try {
      expect((await run(agent, makeInput({ tools: TOOLS }))).at(-1)!.type).toBe("RUN_FINISHED");
      expect((await run(agent, { ...transcript, runId: "resolved" })).at(-1)!.type).toBe("RUN_FINISHED");
      const session = client.session!;
      expect(session.resolved).toEqual(["req-1"]);

      script.splice(0, script.length, { id: "cancelled", type: "abort", data: {} });
      expect((await run(agent, {
        ...transcript, runId: "cancelled",
        messages: [...transcript.messages, { id: "u2", role: "user", content: "Cancel this turn" }],
      })).at(-1)).toMatchObject({ type: "RUN_ERROR", message: "Run cancelled" });
      expect(session.aborted).toBe(true);

      script.splice(0, script.length, ...TEXT_TURN);
      const next = await run(agent, {
        ...transcript, runId: "fresh",
        messages: [...transcript.messages, { id: "u3", role: "user", content: "A new question" }],
      });
      expect(next.filter((event) => event.type === "RUN_ERROR")).toEqual([]);
      expect(next.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      expect(client.session).not.toBe(session);
      expect(client.session!.prompts).toEqual(["A new question"]);
      // L2: the replacement is the same native session (and history), not a new one.
      expect(client.stored.size).toBe(1);
      expect(client.resumed).toEqual([...client.stored]);
    } finally {
      await agent.close();
    }
  });
});
