import { test as base, Page } from "@playwright/test";
import { awaitLLMResponseDone } from "./utils/copilot-actions";
import {
  type CapturedProtocolStream,
  type ProtocolEvidenceAllowance,
  type UnreadableProtocolStream,
  assertProtocolEvidence,
  PROTOCOL_VERSION_LANES,
  protocolVersionLaneOf,
} from "./lib/event-trace-protocol-version";

const PROTOCOL_STREAM_SETTLE_MS = 10_000;

const PROTOCOL_ALLOWANCE_ANNOTATION = "ag-ui-protocol-check-allows";

/**
 * Declares that this test does not produce the run evidence the AG-UI check
 * normally requires, and why. Call it inside the test body:
 *
 * - `no-run`: the test only renders or inspects the page and starts no run.
 * - `error`: the test provokes an error, so a stream may end in RUN_ERROR
 *   before any RUN_STARTED.
 * - `cancel`: the test cancels a run, so that response may be unreadable.
 *
 * A run that does start must still declare its protocol version.
 */
export function allowProtocolEvidenceGap(
  kind: ProtocolEvidenceAllowance,
  reason: string,
) {
  base.info().annotations.push({
    type: PROTOCOL_ALLOWANCE_ANNOTATION,
    description: `${kind}: ${reason}`,
  });
}

/** The enabled-lane integration id of a Dojo page URL (`/<id>/feature/...`). */
function protocolLaneOfPage(url: string): string | undefined {
  try {
    const lane = decodeURIComponent(new URL(url).pathname.split("/")[1] ?? "");
    return PROTOCOL_VERSION_LANES.has(lane) ? lane : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Dump the current state of assistant messages on the page.
 * Called automatically on test failure so CI logs show what the LLM
 * actually produced (or didn't produce) instead of just "Element not found".
 */
async function dumpPageAIState(page: Page) {
  try {
    const state = await page.evaluate(() => {
      // Use data-testid selectors (work with both V1 and V2 CopilotChat)
      const assistantMsgs = Array.from(
        document.querySelectorAll('[data-testid="copilot-assistant-message"]'),
      );
      const userMsgs = Array.from(
        document.querySelectorAll('[data-testid="copilot-user-message"]'),
      );
      const chatContainer = document.querySelector(
        '[data-testid="copilot-chat"]',
      );
      const isRunning = chatContainer?.getAttribute("data-copilot-running");
      // Check for HITL confirm modals
      const confirmModals = Array.from(
        document.querySelectorAll("div.bg-white.rounded.shadow-lg"),
      );
      const confirmButtons = Array.from(
        document.querySelectorAll("button"),
      ).filter((b) => /confirm|reject|accept/i.test(b.textContent || ""));
      // Check for tiptap editor content
      const tiptapEditor = document.querySelector("div.tiptap.ProseMirror");
      return {
        assistantMessages: assistantMsgs.map((el, i) => ({
          index: i,
          text: el.textContent?.trim().slice(0, 200) || "(empty)",
        })),
        userMessages: userMsgs.map((el, i) => ({
          index: i,
          text: el.textContent?.trim().slice(0, 200) || "(empty)",
        })),
        url: window.location.href,
        copilotRunning: isRunning,
        chatContainerFound: chatContainer !== null,
        confirmModals: confirmModals.length,
        confirmModalTexts: confirmModals.map(
          (m) => m.textContent?.trim().slice(0, 100) || "(empty)",
        ),
        confirmButtons: confirmButtons.map((b) => ({
          text: b.textContent?.trim(),
          disabled: b.disabled,
        })),
        tiptapContent:
          tiptapEditor?.textContent?.trim().slice(0, 100) || "(none)",
      };
    });

    // Use console.log so clean-reporter surfaces diagnostic prefixes in CI output
    console.log("\n[AI State Dump] URL:", state.url);
    console.log(
      `[AI State Dump] Chat container: ${state.chatContainerFound ? "found" : "NOT FOUND"}, copilot-running: ${state.copilotRunning ?? "N/A"}`,
    );
    console.log(
      `[AI State Dump] ${state.userMessages.length} user message(s), ${state.assistantMessages.length} assistant message(s)`,
    );
    for (const msg of state.userMessages) {
      console.log(`[AI State Dump] User[${msg.index}]: ${msg.text}`);
    }
    for (const msg of state.assistantMessages) {
      console.log(`[AI State Dump] Assistant[${msg.index}]: ${msg.text}`);
    }
    if (state.assistantMessages.length === 0) {
      console.log("  [Assistant] (no messages — LLM may not have responded)");
    }
    console.log(
      `[AI State Dump] Confirm modals: ${state.confirmModals}, buttons: ${JSON.stringify(state.confirmButtons)}`,
    );
    console.log(`[AI State Dump] Tiptap editor: ${state.tiptapContent}`);
    if (state.confirmModals > 0) {
      for (const t of state.confirmModalTexts) {
        console.log(`  [Modal] ${t}`);
      }
    }
  } catch {
    console.log(
      "[AI State Dump] Could not read page state (page may have navigated away)",
    );
  }
}

/**
 * Dump LLMock journal entries on test failure so CI logs show what the mock
 * server received and returned.
 */
async function dumpLLMockJournal() {
  try {
    // Same port resolution as aimock-setup.ts, so the journal dump follows
    // runs that override AIMOCK_PORT.
    const mockPort = Number(process.env.AIMOCK_PORT) || 5555;
    const res = await fetch(
      `http://localhost:${mockPort}/v1/_requests?limit=20`,
    );
    if (!res.ok) {
      console.log(
        `[LLMock Journal] Non-OK response: ${res.status} ${res.statusText}`,
      );
      return;
    }
    const entries = (await res.json()) as Array<{
      method: string;
      path: string;
      body: {
        model?: string;
        messages?: Array<{ role: string; content?: unknown }>;
      };
      response: {
        status: number;
        fixture?: {
          match?: { userMessage?: string };
          response?: unknown;
        } | null;
      };
    }>;
    console.log(`\n[LLMock Journal] ${entries.length} request(s) recorded:`);
    for (const [i, entry] of entries.entries()) {
      const msgs = entry.body?.messages ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const lastUserText =
        typeof lastUser?.content === "string"
          ? lastUser.content.slice(0, 80)
          : "(non-string)";
      const fixtureName =
        entry.response?.fixture?.match?.userMessage ?? "(predicate)";
      console.log(
        `  [${i}] ${entry.method} ${entry.path} → ${entry.response?.status} | model=${entry.body?.model ?? "?"} msgs=${msgs.length} lastUser="${lastUserText}" fixture="${fixtureName}"`,
      );
    }
  } catch {
    console.log(
      "[LLMock Journal] Could not fetch journal (server may be down)",
    );
  }
}

// Extend base test with isolation setup and error monitoring
export const test = base.extend({
  // Named `provide` rather than Playwright's conventional `use`: `use(...)` is
  // React 19's hook, so eslint-plugin-react-hooks flags the bare call.
  page: async ({ page }, provide, testInfo) => {
    // Before each test - ensure clean state
    await page.context().clearCookies();
    await page.context().clearPermissions();

    // Monitor for app errors so failed backends surface immediately
    // instead of manifesting as opaque timeouts.
    const pageErrors: Error[] = [];
    const networkErrors: string[] = [];
    const agentPosts: string[] = [];

    page.on("pageerror", (error) => {
      console.error(`[PageError] ${error.message}`);
      pageErrors.push(error);
    });

    // Log browser console errors (e.g. CopilotKit runtime logging API failures)
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[BrowserConsole] ${msg.text()}`);
      }
    });

    // Log ALL POST requests to agent backends (helps debug hung SSE streams)
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /copilotkit|agui|agent/i.test(request.url())
      ) {
        const ts = new Date().toISOString().slice(11, 23);
        const msg = `[AgentPOST] ${ts} → ${request.url()}`;
        console.log(msg);
        agentPosts.push(msg);
      }
    });

    // Opt-in AG-UI 1.0 version check (PNI-537): capture SSE runs for lanes
    // listed in lib/event-trace-protocol-version.ts and assert after the test.
    const protocolStreams: Array<
      Promise<CapturedProtocolStream | UnreadableProtocolStream>
    > = [];
    const protocolLanes = new Set<string>();
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const lane = protocolLaneOfPage(frame.url());
      if (lane) protocolLanes.add(lane);
    });
    page.on("response", (response) => {
      const lane = protocolVersionLaneOf({
        method: response.request().method(),
        url: response.url(),
        contentType: response.headers()["content-type"],
      });
      if (!lane || !PROTOCOL_VERSION_LANES.has(lane)) return;
      protocolStreams.push(
        response.body().then(
          (body) => ({
            lane,
            url: response.url(),
            body: body.toString("utf8"),
          }),
          // Kept, not dropped: an unreadable run is a failure unless the test
          // declared it cancels one (allowProtocolEvidenceGap("cancel")).
          (error: unknown) => ({
            lane,
            url: response.url(),
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    });

    // Log ALL responses from agent backends (including SSE stream starts)
    page.on("response", (response) => {
      if (/copilotkit|agui|agent/i.test(response.url())) {
        const ts = new Date().toISOString().slice(11, 23);
        if (response.status() >= 400) {
          const msg = `${response.status()} ${response.url()}`;
          console.error(`[NetworkError] ${msg}`);
          networkErrors.push(msg);
        }
        if (response.request().method() === "POST") {
          console.log(
            `[AgentResp] ${ts} ← ${response.status()} ${response.url()}`,
          );
        }
      }
    });

    await provide(page);

    if (
      testInfo.status === testInfo.expectedStatus &&
      (protocolStreams.length > 0 || protocolLanes.size > 0)
    ) {
      let timeout: number | NodeJS.Timeout | undefined;
      const settled = await Promise.race([
        Promise.all(protocolStreams),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(resolve, PROTOCOL_STREAM_SETTLE_MS);
        }),
      ]).finally(() => clearTimeout(timeout));
      if (!settled) {
        throw new Error(
          `AG-UI protocol version check: response streams did not settle within ${PROTOCOL_STREAM_SETTLE_MS}ms`,
        );
      }
      // User turns, not user messages: consecutive user messages with no
      // assistant reply between them were sent as one turn (a multimodal page
      // can add the attachment and the text as two messages, and a snapshot
      // can re-send the user's message), and one turn starts one run.
      const prompts = await page
        .evaluate(() => {
          let turns = 0;
          let previousWasUser = false;
          document
            .querySelectorAll(
              '[data-testid="copilot-user-message"], .copilotKitUserMessage, [data-testid="copilot-assistant-message"], .copilotKitAssistantMessage',
            )
            .forEach((element) => {
              const isUser =
                element.matches('[data-testid="copilot-user-message"]') ||
                element.classList.contains("copilotKitUserMessage");
              if (isUser && !previousWasUser) turns += 1;
              previousWasUser = isUser;
            });
          return turns;
        })
        .catch(() => 0);
      const allowances = new Set(
        testInfo.annotations
          .filter((annotation) => annotation.type === PROTOCOL_ALLOWANCE_ANNOTATION)
          .map(
            (annotation) =>
              annotation.description?.split(":")[0] as ProtocolEvidenceAllowance,
          ),
      );
      assertProtocolEvidence({
        lanes: [...protocolLanes],
        streams: settled,
        prompts,
        allowances,
      });
    }

    // On failure: dump what the LLM actually did so CI logs are actionable
    if (testInfo.status !== testInfo.expectedStatus) {
      await dumpPageAIState(page);
      await dumpLLMockJournal();
    }

    // After each test - report collected errors
    if (pageErrors.length > 0) {
      console.warn(
        `[Test Cleanup] ${pageErrors.length} page error(s) during test:`,
        pageErrors.map((e) => e.message),
      );
    }
    if (networkErrors.length > 0) {
      console.warn(
        `[Test Cleanup] ${networkErrors.length} network error(s) during test:`,
        networkErrors,
      );
    }
    if (
      testInfo.status !== testInfo.expectedStatus &&
      agentPosts.length > 0
    ) {
      console.log(
        `[Test Cleanup] ${agentPosts.length} agent POST(s) during test:`,
      );
      for (const msg of agentPosts) console.log(`  ${msg}`);
    }
    await page.context().clearCookies();
  },
});

/**
 * Wait for the AI response to finish (SSE stream complete).
 * Delegates to awaitLLMResponseDone which uses the data-copilot-running attribute.
 */
export async function waitForAIResponse(page: Page, timeout: number = 15000) {
  await awaitLLMResponseDone(page, timeout);
}

/**
 * Wait for a specific number of assistant messages to exist with content.
 * More precise than waitForAIResponse when you know the expected message count.
 */
export async function waitForAssistantMessage(
  page: Page,
  options: {
    minMessages?: number;
    timeout?: number;
    stabilizationMs?: number;
  } = {},
) {
  const { minMessages = 1, timeout = 30_000, stabilizationMs = 500 } = options;

  await page.waitForFunction(
    (min: number) => {
      const messages = document.querySelectorAll(
        '[data-testid="copilot-assistant-message"]',
      );
      if (messages.length < min) return false;
      const lastMessage = messages[messages.length - 1];
      return (lastMessage?.textContent?.trim().length ?? 0) > 0;
    },
    minMessages,
    { timeout },
  );

  await page.waitForTimeout(stabilizationMs);
}

export { expect } from "@playwright/test";
