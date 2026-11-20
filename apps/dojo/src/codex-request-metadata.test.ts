import assert from "node:assert/strict";
import test from "node:test";
import { AbstractAgent, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { EMPTY } from "rxjs";
import { projectInput } from "../../../integrations/community/codex-sdk/typescript/src/inputs";
import { codexRequestMetadata } from "./codex-request-metadata";

class CaptureAgent extends AbstractAgent {
  input?: RunAgentInput;
  run(input: RunAgentInput) {
    this.input = input;
    return EMPTY;
  }
}

function input(forwardedProps: unknown): RunAgentInput {
  return {
    threadId: "thread",
    runId: "run",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps,
  };
}

test("Codex bridge removes only the runtime correlation ID without mutating input", () => {
  const downstream = new CaptureAgent();
  const original = input({
    __copilotkitRequestId: "request-1",
    model: "untrusted",
  });
  codexRequestMetadata(original, downstream);
  assert.deepEqual(downstream.input?.forwardedProps, { model: "untrusted" });
  assert.deepEqual(original.forwardedProps, {
    __copilotkitRequestId: "request-1",
    model: "untrusted",
  });
  assert.equal(downstream.input?.messages, original.messages);
});

test("runtime-only metadata becomes empty overrides", () => {
  const downstream = new CaptureAgent();
  codexRequestMetadata(
    input({ __copilotkitRequestId: "request-1" }),
    downstream,
  );
  assert.deepEqual(downstream.input?.forwardedProps, {});
});

test("malformed metadata and other values remain available for adapter rejection", () => {
  for (const props of [
    null,
    undefined,
    [],
    "override",
    1,
    { model: "x" },
    { __copilotkitRequestId: { model: "x" } },
    { __copilotkitRequestId: 1 },
  ]) {
    const downstream = new CaptureAgent();
    const original = input(props);
    codexRequestMetadata(original, downstream);
    assert.equal(downstream.input, original);
  }
});

test("cloned Codex HttpAgent normalizes the serialized request but keeps overrides rejected", async () => {
  const sent: RunAgentInput[] = [];
  const agent = new HttpAgent({
    url: "http://codex.invalid/agentic_chat",
    fetch: async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as RunAgentInput;
      sent.push(wire);
      return new Response(
        [
          { type: "RUN_STARTED", threadId: wire.threadId, runId: wire.runId },
          { type: "RUN_FINISHED", threadId: wire.threadId, runId: wire.runId },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    },
  }).use(codexRequestMetadata);
  for (const forwardedProps of [
    { __copilotkitRequestId: "request-1" },
    { __copilotkitRequestId: "request-2", model: "untrusted" },
  ]) {
    const cloned = agent.clone();
    cloned.messages = [{ id: "user-1", role: "user", content: "Hello" }];
    await cloned.runAgent({ forwardedProps });
  }
  assert.deepEqual(
    sent.map((wire) => wire.forwardedProps),
    [{}, { model: "untrusted" }],
  );
  const limits = { maxInputBytes: 1024, maxMessages: 10 };
  assert.throws(
    () =>
      projectInput(
        { ...sent[0], forwardedProps: { __copilotkitRequestId: "request-1" } },
        undefined,
        limits,
      ),
    /Per-request overrides/,
  );
  assert.doesNotThrow(() => projectInput(sent[0], undefined, limits));
  assert.throws(
    () => projectInput(sent[1], undefined, limits),
    /Per-request overrides/,
  );
});
