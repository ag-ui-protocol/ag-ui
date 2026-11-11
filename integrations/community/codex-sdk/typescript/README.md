# Codex SDK integration

`CodexAgentAdapter` connects the official `@openai/codex-sdk` to AG-UI on a trusted Node.js host. It supports text chat, native conversation continuation, cancellation, and bounded native progress events. The standalone server connects directly to the Flutter Dojo or `HttpAgent`.

This package is under development. Use the repository workspace until its first release. The initial version pins Codex SDK `0.167.1` and requires Node.js 22 or later on a POSIX host. Windows process supervision is not yet supported. The SDK installs its platform-specific Codex CLI through optional dependencies. Keep optional dependencies enabled.

## Run the standalone server

From the repository root, use Node.js from `.node-version` and pnpm from `package.json`.

```sh
pnpm install
pnpm exec nx run @ag-ui/codex-sdk:build
HOST=127.0.0.1 pnpm exec nx run @ag-ui/codex-sdk:start
```

Authenticate with native Codex login or provide `CODEX_API_KEY` on the server host. Optional host settings are `CODEX_MODEL`, `CODEX_WORKING_DIRECTORY`, and `CODEX_PATH`. The server uses port `8032` unless `PORT` is set. Its default workspace is a new scratch Git repository in the system temporary directory. It uses a read-only sandbox, disables network access and web search, and never requests interactive approvals. This is a local development server. Authentication and tenant isolation are the host's responsibility.

After release, an installed consumer starts the same compiled server with `npm explore @ag-ui/codex-sdk -- npm start`. The archive contains the compiled server and requires no repository sources or development dependencies.

`GET /health` reports readiness. `POST /agentic_chat` accepts AG-UI `RunAgentInput` and returns SSE through the official `EventEncoder`. Invalid JSON or schema receives HTTP 400. Requests above 1 MiB receive HTTP 413. Loopback browser origins and requests without an Origin header work by default. Set `CODEX_ALLOWED_ORIGINS` to a comma-separated allowlist for additional browser origins. Output buffering is bounded to 1 MiB. A stalled consumer disconnects after five seconds and cancels its run.

## Use the HTTP client

```ts
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "http://127.0.0.1:8032/agentic_chat",
  threadId: "my-conversation",
});
agent.addMessage({ id: "user-1", role: "user", content: "My name is Alice." });
await agent.runAgent();
agent.addMessage({ id: "user-2", role: "user", content: "What is my name?" });
await agent.runAgent();
```

Keep the public thread ID and the complete returned message history between turns. Keep server-generated assistant message IDs. The adapter sends only newly appended user text into the native Codex session. Read-only request context and state are included with each turn. History edits or truncation require a new public thread.

## Use the adapter directly

```ts
import { CodexAgentAdapter } from "@ag-ui/codex-sdk";

const agent = new CodexAgentAdapter({
  threadOptions: { workingDirectory: "/path/to/scratch/repository" },
});
agent.run({
  threadId: "my-conversation",
  runId: "run-1",
  messages: [{ id: "user-1", role: "user", content: "Hello" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
}).subscribe({ next: event => process.stdout.write(`${JSON.stringify(event)}\n`) });
```

Call `abortRun()` to cancel this adapter's active invocations. Unsubscribing also cancels owned work. `clone()` shares the trusted session store but has independent cancellation controllers. Concurrent invocations on one public thread receive `THREAD_BUSY`; distinct threads can run concurrently. Failed or interrupted native turns require a new public thread, because retrying could duplicate native side effects.

The in-memory store defaults to 1,000 sessions and a 30-minute idle TTL. Restart or eviction expires continuation. Imported assistant history without a trusted session receives `SESSION_EXPIRED`. Configure shared trusted storage through `CodexSessionStore` for host-specific needs. Browser input cannot select a native ID.

## Supported input and output

The first turn accepts system, developer, and user text as labeled transcript context. Continued turns append only user text. The SDK's input is text rather than a native AG-UI role-message array.

Frontend tools, tool-result messages, multimodal input, imported assistant history, frontend approval responses, and nonempty `forwardedProps` are rejected before SDK launch. The adapter does not write shared state or download client URLs. Provider headers, credentials, model settings, executable paths, MCP configuration, and sandbox settings belong to trusted constructor options. Per-request provider-header injection is unavailable.

Assistant aggregate snapshots become suffix-only AG-UI text events. Text lifecycles are serialized for clients that track one active reply. With `showReasoning: true`, exposed SDK reasoning summaries become public reasoning events. Summaries are disabled by default.

Native command, MCP, file, search, and todo items produce `CUSTOM` events named `codex.item`. Their value has `version: 1`, the SDK event phase, and an allowlisted item. Progress includes bounded command output, tool names, file paths, search text, and todo text. It can contain workspace content. It is intended for the trusted host. It does not advertise AG-UI frontend tool execution. Arbitrary MCP metadata and structured payloads are omitted.

Errors expose a stable adapter code and safe message. Host diagnostics are available through `onError`; do not forward them to clients. A staged native completion becomes `RUN_FINISHED` only after clean SDK EOF. A later process error becomes one `RUN_ERROR`.

## Limits

Constructor settings `maxInputBytes`, `maxMessages`, `maxTextBytes`, `maxItems`, `maxProgressBytes`, and `runTimeoutMs` default to 1 MiB, 2,000, 4 MiB, 1,000, 16 KiB, and 120 seconds. All limits are finite positive integers. Assistant text is never silently truncated. Limit violations cancel the run and require a new thread after native execution begins.

The SDK can buffer a JSONL line or stderr before the adapter receives it. Adapter limits cannot bound those upstream buffers. The package supervises the SDK executable in an owned process group. Cancellation first sends SIGTERM, then escalates to SIGKILL after one second. The adapter waits for confirmed process cleanup before releasing thread admission. Unconfirmed cleanup quarantines the thread with `CLEANUP_FAILED`. Process tests cover delayed shutdown after malformed output and output-limit failures on Linux.

## Verify the integration

```sh
pnpm exec nx run @ag-ui/codex-sdk:test
pnpm exec nx run @ag-ui/codex-sdk:typecheck
pnpm exec nx run @ag-ui/codex-sdk:test:exports
pnpm exec nx run @ag-ui/codex-sdk:test:packed
```

The deterministic tests use the real SDK with an explicitly selected JSONL fixture. They verify adapter behavior and process invocation, without contacting a provider. The installed-package check runs ESM and CommonJS consumers and starts the packaged server outside repository sources.

See [the example guide](examples/README.md) for Flutter, web Dojo, fixture mode, and separate real-provider verification.
