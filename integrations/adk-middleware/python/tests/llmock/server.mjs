/**
 * LLMock server for ADK middleware Python integration tests.
 *
 * Starts an LLMock instance that intercepts Gemini API calls made by the
 * google-genai Python client (via GOOGLE_GEMINI_BASE_URL).
 *
 * Usage:
 *   node server.mjs --fixtures-dir <path> [--port PORT]
 *
 * The server prints "LLMOCK_READY <url>" to stdout when ready.
 */

import { LLMock } from "@copilotkit/aimock";
import * as path from "node:path";

// Parse CLI arguments
const args = process.argv.slice(2);
const fixturesIdx = args.indexOf("--fixtures-dir");
const portIdx = args.indexOf("--port");

const FIXTURES_DIR = fixturesIdx !== -1 ? path.resolve(args[fixturesIdx + 1]) : null;
const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 0;

if (!FIXTURES_DIR) {
  console.error("Usage: node server.mjs --fixtures-dir <path> [--port PORT]");
  process.exit(1);
}

const mock = new LLMock({ port, latency: 5 });

// Load JSON fixtures
mock.loadFixtureDir(FIXTURES_DIR);

// ---------------------------------------------------------------------------
// Tool-call fixtures: when a request includes a specific tool and the last
// message is from the user (not a tool result), return a functionCall for
// that tool.  This covers HITL, LRO, and skip_summarization test patterns.
// ---------------------------------------------------------------------------

/** Return true if `req.tools` contains a tool with the given name. */
const hasTool = (req, name) =>
  req.tools?.some((t) => t.function.name === name) ?? false;

/** Return true if the last message in the conversation is from the user. */
const lastIsUser = (req) => {
  const last = req.messages[req.messages.length - 1];
  return last?.role === "user";
};

/** Extract the text of the last user message. */
const lastUserText = (req) => {
  const msg = req.messages.filter((m) => m.role === "user").pop();
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content))
    return msg.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
  return "";
};

// Helper: add a fixture that fires when the request contains `toolName`
// and the last message is a user message.  Returns a functionCall with
// the given arguments.
const addToolCallFixture = (toolName, args) => {
  mock.addFixture({
    match: {
      predicate: (req) => hasTool(req, toolName) && lastIsUser(req),
    },
    response: {
      toolCalls: [{ name: toolName, arguments: JSON.stringify(args) }],
    },
  });
};

// HITL / LRO tools
addToolCallFixture("get_greeting", { name: "Alice" });
addToolCallFixture("approve_action", { action: "task X" });
addToolCallFixture("get_approval", { action: "proceed with the task" });
addToolCallFixture("get_confirmation", {});
addToolCallFixture("check_status", {});
addToolCallFixture("plan_task", { steps: ["Step 1", "Step 2"] });
addToolCallFixture("plan_steps", {
  steps: [
    { description: "Buy groceries", status: "enabled" },
    { description: "Cook dinner", status: "enabled" },
    { description: "Serve food", status: "enabled" },
  ],
});
addToolCallFixture("approve_plan", {
  plan: { topic: "Paris trip", sections: ["Day 1", "Day 2"] },
});
addToolCallFixture("verify_sources", {
  sources: [{ title: "Source 1", url: "https://example.com" }],
});

// skip_summarization backend tools
addToolCallFixture("get_weather_with_skip_summarization", {
  location: "San Francisco",
});
addToolCallFixture("get_temperature", { location: "Boston" });
addToolCallFixture("weather_skip_sum", { city: "Seattle" });
addToolCallFixture("tool_with_skip", { query: "skip query" });
addToolCallFixture("tool_without_skip", { query: "normal query" });
addToolCallFixture("slow_skip_tool", { data: "test_value" });

// ---------------------------------------------------------------------------
// Tool result catch-all: when the last message is a tool result,
// return a generic text acknowledgment (same pattern as Dojo aimock-setup.ts)
// ---------------------------------------------------------------------------
mock.prependFixture({
  match: {
    predicate: (req) => {
      const last = req.messages[req.messages.length - 1];
      return last?.role === "tool";
    },
  },
  response: { content: "Done! I've completed that for you." },
});

// Universal catch-all: matches any request not handled above
mock.addFixture({
  match: {
    predicate: (req) => {
      const lastUser = req.messages.filter((m) => m.role === "user").pop();
      const userText =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? lastUser.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("")
            : "(no user msg)";
      console.error(
        `[llmock CATCH-ALL] model=${req.model} lastUser="${String(userText).slice(0, 80)}" msgs=${req.messages.length}`,
      );
      return true;
    },
  },
  response: { content: "I understand. How can I help you with that?" },
});

const url = await mock.start();

// Signal readiness to the parent process (pytest conftest reads this)
console.log(`LLMOCK_READY ${url}`);

// Keep alive until killed
process.on("SIGTERM", async () => {
  await mock.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await mock.stop();
  process.exit(0);
});
