import { describe, it, expect } from "vitest";
import { EventType, type Message } from "@ag-ui/client";
import { collectEvents, makeInput, runThroughClient } from "./helpers";
import {
  FIRST_TURN,
  PATHS,
  capture,
  localAgent,
  ofType,
  remoteAgent,
  type CaptureName,
} from "./subagent-helpers";

// AG-UI counts a subagent's model calls as the run's: RUN_FINISHED's usage
// covers the sub-agents too, whether their streams are hidden or attributed.
// Mastra's own usage leaves them out, but forwards each delegated agent's
// `finish` (its own calls only) inside the delegating call's output. These
// tests run the real Mastra delegation captures with distinct usage per agent,
// so every call is visibly counted once.

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };
const usage = (input: number, output: number): Usage => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
});
/** A running total `step-finish` repeats: counting it would show up at once. */
const STEP_TOTAL = usage(900_000, 90_000);
const OWN = usage(3, 3);

/**
 * A capture whose forwarded `finish` chunks report `byPath[path]` (the path of
 * delegation names, `mid/leaf`), whose forwarded `step-finish` chunks report
 * STEP_TOTAL, and whose supervisor reports `own` (the remote path reads it from
 * the stream; the local one from the response, see `local()`).
 */
function withUsage(name: CaptureName, byPath: Record<string, Usage>): any[] {
  const chunks = structuredClone(capture(name));
  const visit = (chunk: any, path: string[]) => {
    if (chunk?.type !== "tool-output") return;
    const { toolName, output } = chunk.payload ?? {};
    if (typeof toolName !== "string" || !toolName.startsWith("agent-")) return;
    if (typeof output?.type !== "string") return;
    const here = [...path, toolName.slice("agent-".length)];
    if (output.type === "finish") {
      const value = byPath[here.join("/")];
      if (!value) throw new Error(`no usage given for ${here.join("/")}`);
      output.payload.output.usage = value;
    } else if (output.type === "step-finish") {
      output.payload.output.usage = STEP_TOTAL;
    } else if (output.type === "tool-output") {
      visit(output, here);
    }
  };
  for (const chunk of chunks) {
    visit(chunk, []);
    if (chunk.type === "finish") chunk.payload.output.usage = OWN;
    if (chunk.type === "step-finish") chunk.payload.output.usage = STEP_TOTAL;
  }
  return chunks;
}

const SUPERVISOR = { provider: "openai.chat", modelId: "supervisor-model" };
const SUB = { provider: "anthropic.messages", modelId: "sub-model" };
const LEAF = { provider: "google.generative-ai", modelId: "leaf-model" };

/** Sub-agents as `listAgents` returns them: each with a model, `mid` with `leaf`. */
const subagents = {
  researcher: { model: SUB },
  alpha: { model: SUB },
  beta: { model: SUB },
  mid: { model: SUB, listAgents: async () => ({ leaf: { model: LEAF } }) },
};

function local(chunks: any[], options = {}) {
  return localAgent(chunks, options, {
    usage: OWN,
    model: SUPERVISOR,
    listAgents: async () => subagents,
  });
}

const runUsage = async (agent: any, input = FIRST_TURN) =>
  ofType(await collectEvents(agent, input), EventType.RUN_FINISHED)[0]?.usage;

const VISIBILITIES = [
  ["hidden", {}],
  ["attributed", { subagentVisibility: "attributed" }],
] as const;

describe.each(VISIBILITIES)("run usage with sub-agents (%s)", (_v, options) => {
  describe("local agent: one entry per provider and model", () => {
    it("adds a delegated sub-agent's own calls, labelled with its model", async () => {
      const chunks = withUsage("a-single", { researcher: usage(100, 10) });
      expect(await runUsage(local(chunks, options).agent)).toEqual([
        { provider: "openai.chat", model: "supervisor-model", ...OWN },
        {
          provider: "anthropic.messages",
          model: "sub-model",
          ...usage(100, 10),
        },
      ]);
    });

    it("counts each level of a nested delegation once", async () => {
      const chunks = withUsage("c-nested", {
        mid: usage(50, 5),
        "mid/leaf": usage(1000, 100),
      });
      // Entries follow first appearance: the leaf finishes before its parent.
      expect(await runUsage(local(chunks, options).agent)).toEqual([
        { provider: "openai.chat", model: "supervisor-model", ...OWN },
        {
          provider: "google.generative-ai",
          model: "leaf-model",
          ...usage(1000, 100),
        },
        { provider: "anthropic.messages", model: "sub-model", ...usage(50, 5) },
      ]);
    });

    it("sums parallel delegations to sub-agents on the same model", async () => {
      const chunks = withUsage("b-parallel", {
        alpha: usage(100, 10),
        beta: usage(20, 2),
      });
      expect(await runUsage(local(chunks, options).agent)).toEqual([
        { provider: "openai.chat", model: "supervisor-model", ...OWN },
        {
          provider: "anthropic.messages",
          model: "sub-model",
          ...usage(120, 12),
        },
      ]);
    });

    it("merges a sub-agent on the supervisor's model into the supervisor's entry", async () => {
      const chunks = withUsage("a-single", { researcher: usage(100, 10) });
      const agent = localAgent(chunks, options, {
        usage: OWN,
        model: SUPERVISOR,
        listAgents: async () => ({ researcher: { model: SUPERVISOR } }),
      }).agent;
      expect(await runUsage(agent)).toEqual([
        {
          provider: "openai.chat",
          model: "supervisor-model",
          ...usage(103, 13),
        },
      ]);
    });

    it("leaves a sub-agent whose model it cannot read unlabelled", async () => {
      const chunks = withUsage("a-single", { researcher: usage(100, 10) });
      const agent = localAgent(chunks, options, {
        usage: OWN,
        model: SUPERVISOR,
        listAgents: async () => ({
          researcher: { model: "anthropic/sub-model" },
        }),
      }).agent;
      expect(await runUsage(agent)).toEqual([
        { provider: "openai.chat", model: "supervisor-model", ...OWN },
        { ...usage(100, 10) },
      ]);
    });
  });

  describe("remote agent: its sub-agents cannot be seen, so nothing is labelled", () => {
    it("adds every level of delegation to the run's own usage", async () => {
      const chunks = withUsage("c-nested", {
        mid: usage(50, 5),
        "mid/leaf": usage(1000, 100),
      });
      expect(await runUsage(remoteAgent(chunks, options).agent)).toEqual([
        usage(1053, 108),
      ]);
    });
  });

  describe.each(PATHS)("what is not a sub-agent's run (%s)", (_path, make) => {
    it.each(["i-plain-tool-writer", "k-workflow-tool"] as CaptureName[])(
      "%s adds nothing",
      async (name) => {
        const plain = make(capture(name), options);
        const delegatedNone = await runUsage(plain.agent);
        // No forwarded agent `finish`: the run's usage is the supervisor's own.
        if (_path === "remote") {
          const chunks = structuredClone(capture(name));
          for (const chunk of chunks) {
            if (chunk.type === "finish") chunk.payload.output.usage = OWN;
          }
          expect(await runUsage(remoteAgent(chunks, options).agent)).toEqual([
            OWN,
          ]);
        } else {
          expect(delegatedNone).toBeUndefined();
        }
      },
    );
  });

  describe.each(PATHS)("suspend and resume (%s)", (path, make) => {
    it.each([
      ["e2-suspend", "e2-suspend-resume", { answer: "March" }],
      ["e-approval", "e-approval-resume", { approved: true }],
    ] as const)(
      "%s: the paused run adds no sub-agent usage, and the resumed run counts the sub-agent once",
      async (first, resume, payload) => {
        // Mastra forwards no sub-agent usage while a delegation is paused, and
        // the resumed sub-agent's `finish` covers its calls from before the
        // pause too: so each of its calls is counted once across the two runs.
        const paused = make(withUsage(first, {}), options);
        const pausedEvents = await collectEvents(paused.agent, FIRST_TURN);
        const pausedRun = ofType(pausedEvents, EventType.RUN_FINISHED)[0];
        expect(pausedRun.usage).toBeUndefined();
        const interruptId = pausedRun.outcome.interrupts[0].id;
        const history: Message[] = await runThroughClient(
          make(withUsage(first, {}), options).agent,
          FIRST_TURN.messages,
          {},
        );

        const second =
          path === "local" ? local([], options) : remoteAgent([], options);
        second.fake.resumeChunks = withUsage(resume, {
          researcher: usage(107, 13),
        });
        const resumed = await runUsage(
          second.agent,
          makeInput({
            runId: "run-2",
            messages: history,
            resume: [{ interruptId, status: "resolved", payload }],
          }),
        );
        expect(resumed).toEqual(
          path === "local"
            ? [
                { provider: "openai.chat", model: "supervisor-model", ...OWN },
                {
                  provider: "anthropic.messages",
                  model: "sub-model",
                  ...usage(107, 13),
                },
              ]
            : [usage(110, 16)],
        );
      },
    );
  });
});
