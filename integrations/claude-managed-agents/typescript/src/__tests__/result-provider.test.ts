import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { lastValueFrom, toArray } from "rxjs";
import { expect, it } from "vitest";
import { ManagedAgentsAgent } from "../agent";
import { InMemorySessionStore } from "../sessions";
import type { RunAgentInput } from "@ag-ui/client";

it.each(["ts", "py", "dotnet"])(
  "native SDK HTTP replay preserves %s child result across provider restart",
  async (language) => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../../fixtures/child-results.json", import.meta.url),
        "utf8",
      ),
    )[language];
    const native = fixture.native.find(
      (e: { type: string }) => e.type === "agent.tool_result",
    );
    const call = fixture.root[0];
    let store = new InMemorySessionStore();
    const value: RunAgentInput = {
      threadId: "imported",
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      resume: [
        {
          interruptId: call.id,
          status: "resolved",
          payload: fixture.root[1].result,
        },
      ],
    };
    for (const completed of [false, true]) {
      if (completed) {
        const snapshot = JSON.stringify(store.get("1:a|0:|1:e|0:|imported"));
        store = new InMemorySessionStore();
        store.set("1:a|0:|1:e|0:|imported", JSON.parse(snapshot));
      }
      const provider = spawn(
        process.env.AGUI_TEST_PYTHON ?? "python3",
        [
          fileURLToPath(
            new URL("../../../tests/result_provider.py", import.meta.url),
          ),
          language,
          ...(completed ? ["completed"] : []),
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      try {
        const lines = createInterface({ input: provider.stdout });
        const [port] = await once(lines, "line", {
          signal: AbortSignal.timeout(5000),
        });
        const client = new Anthropic({
          apiKey: "local-test",
          baseURL: `http://127.0.0.1:${port}`,
          maxRetries: 0,
        });
        const agent = new ManagedAgentsAgent({
          managedAgentId: "a",
          environmentId: "e",
          client,
          sessionStore: store,
          resolveSession: () => ({ sessionId: "native" }),
        });
        const events = await lastValueFrom(
          agent
            .run(completed ? { ...value, resume: undefined } : value)
            .pipe(toArray()),
        );
        const results = events.filter((e) => e.type === "TOOL_CALL_RESULT");
        expect(events.at(-1)?.type).toBe("RUN_FINISHED");
        if (completed) expect(results).toEqual([]);
        else {
          expect(results).toHaveLength(1);
          expect(results[0]).toMatchObject({
            messageId: native.id,
            toolCallId: call.id,
          });
          const content = results[0].content;
          if (typeof content !== "string")
            throw new Error("Expected plain native result content");
          expect(native.is_error ? JSON.parse(content) : content).toEqual(
            native.is_error
              ? { error: true, content: native.content[0].text }
              : native.content[0].text,
          );
        }
      } finally {
        if (provider.exitCode === null && provider.signalCode === null) {
          const exited = once(provider, "exit");
          provider.kill();
          await exited;
        }
      }
    }
  },
  15000,
);
