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
    /Delivery unconfirmed: fetch failed\.\s+Your answer may have reached the agent\./,
  );
  assert.doesNotMatch(html, / disabled=""/);
  assert.match(html, /answer again to resend it/);
  assert.doesNotMatch(html, /Not delivered/);
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
  // Per card: the locked answer's button is a live retry, the opposite one is
  // disabled. Card 1 locked Approve, card 2 locked Reject.
  const cards = html.split('data-testid="approval-card"').slice(1);
  assert.equal(cards.length, 2);
  const button = (card: string, id: "approve" | "reject") =>
    card.match(
      new RegExp(`<button[^>]*data-testid="approval-${id}"[^>]*>`),
    )?.[0] ?? "";
  assert.doesNotMatch(button(cards[0], "approve"), / disabled=""/);
  assert.match(button(cards[0], "reject"), / disabled=""/);
  assert.match(cards[0], /Retry: Approve/);
  assert.match(button(cards[1], "approve"), / disabled=""/);
  assert.doesNotMatch(button(cards[1], "reject"), / disabled=""/);
  assert.match(cards[1], /Retry: Reject/);
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

test("a skipped answer shows its message and no card", () => {
  const html = render({
    approvals: [],
    notices: [
      {
        id: "b",
        label: "term-b",
        message:
          "Not delivered: this request expired before your answer reached the agent. It will not be sent again.",
      },
      { id: "c", message: "Not delivered: expired" },
    ],
  });
  assert.match(html, /data-testid="approval-skipped"/);
  assert.match(html, /expired before your answer reached the agent/);
  assert.match(html, /term-b/);
  assert.match(html, /<code>c<\/code>/);
  assert.equal((html.match(/data-testid="approval-skipped"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-testid="approval-card"/);
});

test("the card shrinks to a narrow preview and keeps its desktop width", () => {
  const html = render({
    approvals: [{ id: "a", request: { toolName: "x" } }],
  });
  assert.match(html, /w-full max-w-\[420px\]/);
});

test("a request with no id renders disabled buttons and says why", () => {
  const noId = [
    { id: undefined, request: { toolName: "tool" } },
  ] as unknown as Parameters<typeof ApprovalPanel>[0]["approvals"];
  const html = render({ approvals: noId });
  assert.match(html, /data-testid="approval-card"/);
  assert.match(
    html,
    /This request has no id, so it can(&#x27;|&apos;|')t be answered here\./,
  );
  assert.equal((html.match(/ disabled=""/g) ?? []).length, 2);
  // A normal card is unaffected.
  assert.doesNotMatch(render({}), /approval-no-id/);
});

test("each button has an accessible name with its action and its target", () => {
  const second = {
    ...interrupt,
    id: "int-2",
    metadata: { provider: "claude-code", terminalId: "t2" },
  };
  const html = render({
    approvals: collectApprovals(undefined, [interrupt, second]),
  });
  const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
    "Approve: claude-code in terminal t1",
    "Reject: claude-code in terminal t1",
    "Approve: claude-code in terminal t2",
    "Reject: claude-code in terminal t2",
  ]);
  const locked = render({
    approvals: collectApprovals(undefined, [interrupt]),
    locked: new Map([["int-1", true]]),
  });
  assert.match(
    locked,
    /aria-label="Retry: Approve: claude-code in terminal t1"/,
  );
  assert.match(locked, /aria-label="Reject: claude-code in terminal t1"/);
});

test("the card list has a height cap so many cards cannot push the chat out", () => {
  const many = collectApprovals(
    undefined,
    ["a", "b", "c", "d", "e", "f"].map((id) => ({ ...interrupt, id })),
  );
  const html = render({ approvals: many });
  assert.match(
    html,
    /max-h-\[50vh\][^"]*overflow-y-auto|overflow-y-auto[^"]*max-h-\[50vh\]/,
  );
  assert.equal((html.match(/data-testid="approval-card"/g) ?? []).length, 6);
});

test("two generic cards with the same tool name get different button names", () => {
  const same = (id: string) => ({
    id,
    reason: "needs_input",
    metadata: {},
    responseSchema: APPROVED_SCHEMA,
  });
  const html = render({
    approvals: collectApprovals(undefined, [same("req-1"), same("req-2")]),
  });
  const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(labels.length, 4);
  assert.equal(new Set(labels).size, 4);
  assert.match(labels[0], /^Approve: .* \(request req-1\)$/);
  assert.match(labels[3], /^Reject: .* \(request req-2\)$/);
});
