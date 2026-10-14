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
// `fragment` is written after the events as a separate chunk: the start of an
// event cut off mid-JSON. `delayMs` holds the response headers back.
type Reply = { events: Event[]; holdOpen?: boolean; fragment?: string; delayMs?: number };

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
  // Cancelled between chunks, in the middle of an event.
  "cancel-mid-event": [{ events: [started("r1")], fragment: 'data: {"type":"TEXT_MESSAGE_ST', holdOpen: true }],
  // The page cancels through reader.cancel(), not an abort signal.
  "reader-cancel": [{ events: [started("r1")], holdOpen: true }],
  // Two prompts in flight at once: the first one's headers arrive last, and
  // the second one's response replays the first one's run.
  "overlapping-replay": [
    { events: [...run("r1").events, ...run("r2").events], delayMs: 400 },
    run("r1"),
  ],
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
// cancel: undefined, "abort" (abort signal) or "reader" (reader.cancel());
// cancelAfter: chunks to receive before cancelling.
window.send = async (scenario, text, cancel, cancelAfter = 1) => {
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
  let chunks = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text_ += new TextDecoder().decode(value);
      chunks += 1;
      if (cancel && chunks >= cancelAfter) {
        if (cancel === "reader") await reader.cancel("stop"); else controller.abort();
        break;
      }
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
      const respond = () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(reply.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
        if (reply.fragment) setTimeout(() => res.write(reply.fragment), 100);
        if (!reply.holdOpen) res.end();
      };
      if (reply.delayMs) setTimeout(respond, reply.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

type Cancel = "abort" | "reader" | undefined;

async function send(
  page: import("@playwright/test").Page,
  scenario: string,
  text: string,
  cancel: Cancel = undefined,
  cancelAfter = 1,
) {
  await page.evaluate(
    ([s, t, c, n]) => (window as unknown as { send: (...a: unknown[]) => Promise<void> }).send(s, t, c, n),
    [scenario, text, cancel, cancelAfter] as const,
  );
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
  await send(page, "cancel-after-undeclared", "second", "abort");
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(2);
});

test("cancel-only: the only run declares 1.0 and is then cancelled", async ({ page }) => {
  allowProtocolEvidenceGap("cancel", "the run is cancelled");
  await page.goto(`${base}/${LANE}/feature/chat`);
  await send(page, "cancel-only", "only", "abort");
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(1);
});

test("cancel-mid-event: cancelled after a declared run, in the middle of the next event", async ({ page }) => {
  allowProtocolEvidenceGap("cancel", "the run is cancelled");
  await page.goto(`${base}/${LANE}/feature/chat`);
  await send(page, "cancel-mid-event", "only", "abort", 2);
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(1);
});

test("reader-cancel: the page cancels the stream through its reader", async ({ page }) => {
  allowProtocolEvidenceGap("cancel", "the run is cancelled");
  await page.goto(`${base}/${LANE}/feature/chat`);
  await send(page, "reader-cancel", "only", "reader");
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(1);
});

test("overlapping-replay: a later prompt's replay arrives before the earlier prompt's runs", async ({ page }) => {
  await page.goto(`${base}/${LANE}/feature/chat`);
  await Promise.all([send(page, "overlapping-replay", "first"), send(page, "overlapping-replay", "second")]);
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(2);
});
