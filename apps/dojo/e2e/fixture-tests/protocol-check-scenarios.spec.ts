import http from "node:http";
import type { AddressInfo } from "node:net";
import { allowProtocolEvidenceGap, expect, test } from "../test-isolation-helper";

// Browser scenarios for the shared AG-UI protocol check in
// test-isolation-helper.ts, run against a local server instead of a Dojo
// integration. Each scenario's expected verdict (pass, or fail with a given
// message) is asserted by protocol-check.test.ts, which runs this file through
// Playwright; the scenarios themselves only drive the page. The cases come from
// the review of #3051.

const LANE = "server-starter";

type Event = Record<string, unknown>;
type Reply = { events: Event[]; holdOpen?: boolean };

// Per scenario, the reply to the n-th prompt.
const SCENARIOS: Record<string, Reply[]> = {
  "fresh-runs": [run("r1"), run("r2")],
  "extra-runs-then-empty": [{ events: [...run("r1").events, ...run("r2").events] }, { events: [] }],
  "replayed-run": [run("r1"), run("r1")],
  // Two valid runs first, so a check that only counts runs is satisfied and
  // only the cancelled run's missing version is left to catch.
  "cancel-after-undeclared": [
    { events: [...run("r1").events, ...run("r3").events] },
    { events: [{ type: "RUN_STARTED", runId: "r2", threadId: "t" }], holdOpen: true },
  ],
  "cancel-only": [{ events: [started("r1")], holdOpen: true }],
};

function started(runId: string): Event {
  return { type: "RUN_STARTED", runId, threadId: "t", protocolVersion: "1.0" };
}

function run(runId: string): Reply {
  return {
    events: [
      started(runId),
      { type: "TEXT_MESSAGE_START", messageId: `m-${runId}`, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: `m-${runId}`, delta: `answer ${runId}` },
      { type: "TEXT_MESSAGE_END", messageId: `m-${runId}` },
      { type: "RUN_FINISHED", runId, threadId: "t" },
    ],
  };
}

// A chat page with the Dojo's message test ids. send(text, cancel) posts the
// conversation like CopilotKit does, renders the reply, and with `cancel`
// aborts the request once the first chunk has arrived.
const PAGE = `<!doctype html><html><body><div id="chat"></div><script>
const messages = [];
let n = 0;
function add(role, text) {
  const div = document.createElement("div");
  div.dataset.testid = role === "user" ? "copilot-user-message" : "copilot-assistant-message";
  div.textContent = text;
  document.getElementById("chat").appendChild(div);
}
window.send = async (scenario, text, cancel) => {
  const message = { id: "u" + (++n), role: "user", content: text };
  messages.push(message);
  add("user", text);
  const controller = new AbortController();
  const response = await fetch("/api/copilotkit/${LANE}/agent/a/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "t", runId: "x" + n, scenario, messages }),
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  let text_ = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text_ += new TextDecoder().decode(value);
      if (cancel) { controller.abort(); break; }
    }
  } catch {}
  add("assistant", text_.length ? "reply " + n : "(empty)");
};
</script></body></html>`;

let server: http.Server;
let base = "";

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as { scenario: string; messages: unknown[] };
      const prompt = body.messages.filter((m) => (m as { role: string }).role === "user").length;
      const reply = SCENARIOS[body.scenario][prompt - 1];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of reply.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (!reply.holdOpen) res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function send(page: import("@playwright/test").Page, scenario: string, text: string, cancel = false) {
  await page.evaluate(([s, t, c]) => (window as unknown as { send: (...a: unknown[]) => Promise<void> }).send(s, t, c), [
    scenario,
    text,
    cancel,
  ] as const);
}

test("fresh-runs: each prompt gets its own run", async ({ page }) => {
  await page.goto(`${base}/${LANE}/feature/chat`);
  await send(page, "fresh-runs", "first");
  await send(page, "fresh-runs", "second");
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(2);
});

test("extra-runs-then-empty: the first prompt streams two runs, the second gets an empty stream", async ({ page }) => {
  await page.goto(`${base}/${LANE}/feature/chat`);
  await send(page, "extra-runs-then-empty", "first");
  await send(page, "extra-runs-then-empty", "second");
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(2);
});

test("replayed-run: the second prompt's response replays the first run", async ({ page }) => {
  await page.goto(`${base}/${LANE}/feature/chat`);
  await send(page, "replayed-run", "first");
  await send(page, "replayed-run", "second");
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(2);
});

test("cancel-after-undeclared: a cancelled run started without a version", async ({ page }) => {
  allowProtocolEvidenceGap("cancel", "the second prompt is cancelled");
  await page.goto(`${base}/${LANE}/feature/chat`);
  await send(page, "cancel-after-undeclared", "first");
  await send(page, "cancel-after-undeclared", "second", true);
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(2);
});

test("cancel-only: the only run declares 1.0 and is then cancelled", async ({ page }) => {
  allowProtocolEvidenceGap("cancel", "the run is cancelled");
  await page.goto(`${base}/${LANE}/feature/chat`);
  await send(page, "cancel-only", "only", true);
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(1);
});
