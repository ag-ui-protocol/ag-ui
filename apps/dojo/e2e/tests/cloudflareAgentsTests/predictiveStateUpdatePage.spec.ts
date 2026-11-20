import { test, expect } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/awsStrandsPages/PredictiveStateUpdatesPage";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { expectRunFinished } from "../../utils/runtime-sse";
import { parseEventTraceSse } from "../../lib/event-trace-events";

// Predictive state updates for Cloudflare Agents. `write_document` is a
// FRONTEND tool. Unlike the bridges that send a PredictState mapping and let
// the browser project the arguments, the Worker's writer agent predicts the
// state itself: as the model streams the call's arguments, it parses the
// partial `document` and sends it as a STATE_SNAPSHOT, before the call is
// complete and before the user confirms it.
//
// The first test asserts that on the wire, because the DOM cannot tell it from
// a document that only arrives once the call is complete. The second covers
// the decision the dialog gates, through the agent's reply.
//
// The confirm dialog is the DOM anchor throughout, because it gates a halted
// frontend tool and so cannot be missed by a fast run, unlike the editor's
// text. The editor's contents are not asserted, for the reason given in the
// AWS Strands spec this one is ported from.
const PAGE_URL = "/cloudflare-agents/feature/predictive_state_updates";
const FIRST_REQUEST =
  "Give me a story for a dragon called Atlantis in document";
const SECOND_REQUEST = "Change dragon name to Lola";
const TOOL = "write_document";

/**
 * Assert the run streamed `state.document` from `write_document`'s arguments
 * while they were still streaming: several partial documents, each a prefix
 * of the final one, between the call's TOOL_CALL_START and TOOL_CALL_END.
 */
function expectDocumentPredictedFromArgs(sse: string) {
  const events = parseEventTraceSse(sse);
  const start = events.findIndex(
    (event) => event.type === "TOOL_CALL_START" && event.toolCallName === TOOL,
  );
  expect(
    start,
    `${TOOL} TOOL_CALL_START must reach the wire`,
  ).toBeGreaterThanOrEqual(0);
  const callId = events[start]!.toolCallId;
  const end = events.findIndex(
    (event, i) =>
      i > start &&
      event.type === "TOOL_CALL_END" &&
      event.toolCallId === callId,
  );
  expect(end, `${TOOL} TOOL_CALL_END must follow its start`).toBeGreaterThan(
    start,
  );

  const during = events.slice(start + 1, end);
  const argDeltas = during
    .filter(
      (event) => event.type === "TOOL_CALL_ARGS" && event.toolCallId === callId,
    )
    .map((event) => String(event.delta));
  // One frame would mean the provider buffered the arguments, leaving nothing
  // to predict from.
  expect(
    argDeltas.length,
    `${TOOL} arguments must stream as multiple incremental deltas`,
  ).toBeGreaterThanOrEqual(3);
  const finalDocument = (JSON.parse(argDeltas.join("")) as { document: string })
    .document;

  const predicted = [
    ...new Set(
      during
        .filter((event) => event.type === "STATE_SNAPSHOT")
        .map((event) => (event.snapshot as { document?: unknown })?.document)
        .filter((document): document is string => typeof document === "string"),
    ),
  ];
  const partial = predicted.filter(
    (document) => document.length > 0 && document.length < finalDocument.length,
  );
  expect(
    partial.length,
    "state.document must be streamed in several partial snapshots while the arguments stream",
  ).toBeGreaterThanOrEqual(3);
  for (const document of predicted) {
    expect(
      finalDocument.startsWith(document),
      `a predicted document must be a prefix of the final one: ${JSON.stringify(document)}`,
    ).toBe(true);
  }
}

test.describe("Predictive State Updates Feature", () => {
  test("[Cloudflare Agents] streams the document into state while the tool arguments stream", async ({
    page,
  }) => {
    const predictive = new PredictiveStateUpdatesPage(page);

    await gotoAndAwaitRuntimeInfo(page, PAGE_URL);
    await predictive.awaitChatReady();

    // Capture before sending: the run starts on the click.
    const ssePromise = predictive.captureRuntimeSSE(
      "cloudflare-agents",
      "dragon called Atlantis",
    );

    await predictive.sendMessage(FIRST_REQUEST);

    // The proposed change is waiting on the user.
    await expect(predictive.confirmModal).toBeVisible({ timeout: 30_000 });

    const sse = await ssePromise;
    expectRunFinished(sse, "write_document run");
    expectDocumentPredictedFromArgs(sse);

    // Answered rather than walked away from: an unanswered frontend tool leaves
    // the agent's thread waiting on a result that never comes.
    await predictive.approveChanges();
    await predictive.awaitConfirmDismissed();
  });

  test("[Cloudflare Agents] carries a rejected edit back to the agent", async ({
    page,
  }) => {
    const predictive = new PredictiveStateUpdatesPage(page);

    await gotoAndAwaitRuntimeInfo(page, PAGE_URL);
    await predictive.awaitChatReady();

    await predictive.sendMessage(FIRST_REQUEST);
    await expect(predictive.confirmModal).toBeVisible({ timeout: 30_000 });
    await predictive.approveChanges();
    await predictive.awaitConfirmDismissed();

    // A second turn proposes an edit to the document the first turn wrote, so
    // this dialog is the one whose rejection is under test.
    await predictive.sendMessage(SECOND_REQUEST);
    await expect(predictive.confirmModal).toBeVisible({ timeout: 30_000 });

    // The frontend tool's result carries the rejection back, and the agent's
    // answer proves it landed: the reply differs on a rejected edit, so an
    // approval reaching the agent instead would fail here.
    await predictive.rejectChanges();
    await predictive.awaitConfirmDismissed();
    await expect(predictive.assistantMessages.last()).toContainText(
      /discarded that edit/i,
      { timeout: 30_000 },
    );
  });
});
