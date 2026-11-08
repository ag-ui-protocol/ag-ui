import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalPanel } from "@/components/tool-approval-panel";
import { collectApprovals } from "./tool-approval";

const APPROVED_SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
};
const interrupt = {
  id: "int-1",
  reason: "claude-code:permission_request",
  metadata: { provider: "claude-code", terminalId: "t1" },
};
const approvals = collectApprovals(undefined, [interrupt]);
const render = (props: Partial<Parameters<typeof ApprovalPanel>[0]>) =>
  renderToStaticMarkup(
    <ApprovalPanel
      approvals={approvals}
      answered={new Map()}
      locked={new Map()}
      sending={false}
      error={null}
      onDecide={() => undefined}
      {...props}
    />,
  );

test("an open interrupt renders an actionable card and no alert", () => {
  const html = render({});
  assert.match(html, /data-testid="approval-card"/);
  assert.doesNotMatch(html, /data-testid="approval-error"/);
  assert.doesNotMatch(html, / disabled=""/);
});

test("while the answer is in flight the card stays with its buttons disabled", () => {
  const html = render({ sending: true });
  assert.match(html, /data-testid="approval-card"/);
  assert.equal((html.match(/ disabled=""/g) ?? []).length >= 2, true);
});

test("after a failed decision the card is still there, enabled, with the alert", () => {
  const html = render({ error: "fetch failed" });
  assert.match(html, /data-testid="approval-card"/);
  assert.match(
    html,
    /Not delivered: fetch failed\. The approval card is still here\./,
  );
  assert.doesNotMatch(html, / disabled=""/);
  assert.doesNotMatch(html, /Send any message/);
});

test("an interrupt answered while others wait stays visible, showing its answer", () => {
  const second = { ...interrupt, id: "int-2" };
  const both = collectApprovals(undefined, [interrupt, second]);
  const html = render({
    approvals: both,
    answered: new Map([["int-1", true]]),
  });
  assert.equal((html.match(/data-testid="approval-card"/g) ?? []).length, 2);
  assert.equal((html.match(/data-testid="approval-answer"/g) ?? []).length, 1);
  assert.match(html, /Approved: waiting to send/);
});

test("a mixed batch shows a card for each interrupt; answering one leaves both visible", () => {
  const other = {
    id: "int-9",
    reason: "needs_input",
    metadata: {},
    responseSchema: APPROVED_SCHEMA,
  };
  const mixed = collectApprovals(undefined, [interrupt, other]);
  const both = render({ approvals: mixed });
  assert.equal((both.match(/data-testid="approval-card"/g) ?? []).length, 2);
  assert.match(both, /Interrupt int-9/);
  assert.match(both, /needs_input/);
  const rest = render({
    approvals: mixed,
    answered: new Map([["int-1", false]]),
  });
  assert.equal((rest.match(/data-testid="approval-card"/g) ?? []).length, 2);
  assert.match(rest, /Rejected: waiting to send/);
});

test("after a failed batch the sent answers are locked: retry the same answer only", () => {
  const second = { ...interrupt, id: "int-2" };
  const both = collectApprovals(undefined, [interrupt, second]);
  const html = render({
    approvals: both,
    locked: new Map([
      ["int-1", true],
      ["int-2", false],
    ]),
    error: "fetch failed",
  });
  assert.equal((html.match(/data-testid="approval-card"/g) ?? []).length, 2);
  assert.match(html, /Approve sent; it may already have reached the agent/);
  assert.match(html, /Reject sent; it may already have reached the agent/);
  assert.match(html, /Retry: Approve/);
  assert.match(html, /Retry: Reject/);
  // One button per card is disabled: the opposite of the locked answer.
  assert.equal((html.match(/ disabled=""/g) ?? []).length, 2);
  assert.match(html, /Answers that\s+were already sent are locked/);
});

test("a request the page cannot answer has no buttons, shows its schema and blocks the batch", () => {
  const meeting = {
    id: "m-1",
    reason: "mastra:tool_suspend",
    metadata: {},
    responseSchema: {
      type: "object",
      properties: { choice: { type: "string" } },
      required: ["choice"],
    },
  };
  const html = render({
    approvals: collectApprovals(undefined, [interrupt, meeting]),
  });
  assert.match(html, /data-testid="approval-blocked"/);
  assert.match(html, /can&#x27;t answer every pending request/);
  assert.match(html, /can&#x27;t answer this kind of request/);
  assert.match(html, /&quot;choice&quot;/);
  assert.equal((html.match(/data-testid="approval-card"/g) ?? []).length, 2);
  // Only the answerable card has buttons, and they are disabled.
  assert.equal((html.match(/data-testid="approval-approve"/g) ?? []).length, 1);
  assert.equal((html.match(/ disabled=""/g) ?? []).length, 2);
});
