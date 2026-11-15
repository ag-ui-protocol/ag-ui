import { type TraceEvent, parseEventTraceSse } from "./event-trace-events";

/**
 * Shared AG-UI 1.0 version-declaration check (PNI-537).
 *
 * The 1.0 spec (docs/spec/1.0/basic/versioning.mdx) requires a producer to
 * declare the protocol it speaks on `RUN_STARTED.protocolVersion`. This module
 * checks that, for every run a Dojo page streams back from
 * `/api/copilotkit/<integrationId>/...`, the run's first RUN_STARTED carries
 * `protocolVersion: "1.0"`.
 *
 * The check is opt-in per Dojo integration id. `test-isolation-helper.ts`
 * applies it automatically to every spec that imports `test` from there (or
 * from `event-trace-test.ts`) once the page's integration id is listed in
 * {@link PROTOCOL_VERSION_LANES}.
 *
 * Enabling a lane: when the integration ticket that makes the lane's producer
 * declare `protocolVersion` lands, add its Dojo integration id (the `id` in
 * `apps/dojo/src/menu.ts`) to {@link PROTOCOL_VERSION_LANES}.
 */
export const EXPECTED_PROTOCOL_VERSION = "1.0";

/**
 * Dojo integration ids whose producers declare `protocolVersion` on main.
 *
 * Never add `langgraph` or `langgraph-fastapi` (LangGraph Python keeps a
 * deliberate ag-ui-protocol 0.x floor) or `spring-ai` (its producer is not on
 * the 1.0 line).
 */
export const PROTOCOL_VERSION_LANES: ReadonlySet<string> = new Set([
  // integrations/adk-middleware/js/src/agent.ts declares PROTOCOL_VERSION.
  "adk-js",
  // ag_ui_crewai declares PROTOCOL_VERSION on every RunStartedEvent.
  "crewai",
  "crewai-conversational-flows",
  // ag_ui_adk declares PROTOCOL_VERSION on every RunStartedEvent.
  "adk-middleware",
  // The A2A middleware passes through its orchestrator's RUN_STARTED, and the
  // demo's orchestrator is ag_ui_adk.
  "a2a",
  // ag_ui_claude_sdk and @ag-ui/claude-agent-sdk declare PROTOCOL_VERSION on RUN_STARTED.
  "claude-agent-sdk-python",
  "claude-agent-sdk-typescript",
  // ag_ui_strands and @ag-ui/aws-strands declare PROTOCOL_VERSION on RUN_STARTED.
  "aws-strands",
  "aws-strands-typescript",
  // @ag-ui/langchain declares PROTOCOL_VERSION on RUN_STARTED.
  "langchain",
  // The server-starter templates declare PROTOCOL_VERSION on every RUN_STARTED.
  "server-starter",
  "server-starter-all-features",
  // @ag-ui/watsonx declares PROTOCOL_VERSION on RUN_STARTED.
  "watsonx",
  // @ag-ui/langgraph declares PROTOCOL_VERSION on every RUN_STARTED.
  "langgraph-typescript",
  // MAF .NET streams through AGUI.Server, which declares PROTOCOL_VERSION on
  // RUN_STARTED from 1.0.1 (the Dojo example pins it).
  "microsoft-agent-framework-dotnet",
  // The .NET SDK's own sample server streams through AGUI.Server too.
  "ag-ui-dotnet",
  // ag2 (ag2.ag_ui) declares PROTOCOL_VERSION on RUN_STARTED from 1.1.2.
  "ag2",
  // ag_ui_agentspec declares PROTOCOL_VERSION on RUN_STARTED (both runtimes).
  "agent-spec-langgraph",
  "agent-spec-wayflow",
  // @ag-ui/cloudflare-agents declares PROTOCOL_VERSION on RUN_STARTED.
  "cloudflare-agents",
  // The Claude Managed Agents adapters (Python, TypeScript, .NET) declare the
  // protocol version on RUN_STARTED.
  "claude-managed-agents-python",
  "claude-managed-agents-typescript",
  "claude-managed-agents-dotnet",
]);

const COPILOTKIT_ROUTE = /^\/api\/copilotkit(?:next)?\/([^/]+)(?:\/|$)/;

export type ResponseMetadata = {
  method: string;
  url: string;
  contentType: string | undefined;
};

/**
 * The Dojo integration id of an AG-UI SSE response from the Dojo CopilotKit
 * route, or undefined when the response is not one.
 */
export function protocolVersionLaneOf(
  response: ResponseMetadata,
): string | undefined {
  if (response.method !== "POST") return undefined;
  if (!response.contentType?.toLowerCase().includes("text/event-stream")) {
    return undefined;
  }
  const match = COPILOTKIT_ROUTE.exec(new URL(response.url).pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export type ProtocolVersionViolation = {
  runId: string;
  protocolVersion: unknown;
};

/**
 * Returns one violation per run whose first RUN_STARTED does not declare the
 * expected protocol version. Runs are keyed by `runId`; a stream may carry
 * several sequential runs and each must declare its own version.
 */
export function findProtocolVersionViolations(
  events: readonly TraceEvent[],
  expected: string = EXPECTED_PROTOCOL_VERSION,
): ProtocolVersionViolation[] {
  const seen = new Set<string>();
  const violations: ProtocolVersionViolation[] = [];
  for (const event of events) {
    if (event.type !== "RUN_STARTED") continue;
    const runId = String(event.runId ?? `<missing runId #${seen.size}>`);
    if (seen.has(runId)) continue;
    seen.add(runId);
    if (event.protocolVersion !== expected) {
      violations.push({ runId, protocolVersion: event.protocolVersion });
    }
  }
  return violations;
}

/**
 * One AG-UI response stream, as the page received it.
 *
 * - `body`: the SSE text received, including the part received before a
 *   cancellation or failure, so a RUN_STARTED that arrived is still judged.
 * - `outcome`: `complete` when the stream ended normally, `aborted` when the
 *   page cancelled it, `failed` when reading it failed for any other reason.
 * - `promptKey`: the latest user message the request carried (its id, or its
 *   content when it has none), i.e. the prompt this stream answers. Undefined
 *   when the request carried no user message.
 */
export type ProtocolStream = {
  lane: string;
  url: string;
  promptKey?: string;
  body: string;
  outcome: "complete" | "aborted" | "failed";
  error?: string;
};

/**
 * What a test declares about runs it does not expect to complete normally.
 * Each needs a reason, so a passing spec never looks like conformance evidence
 * it did not produce.
 *
 * - `no-run`: the test only renders or inspects the page and starts no run.
 * - `error`: the test provokes an error; a stream may end in RUN_ERROR before
 *   any RUN_STARTED.
 * - `cancel`: the test cancels a run. It covers only the streams the page
 *   itself aborted, and only their missing run: whatever such a stream
 *   received before the cancellation is still judged.
 */
export type ProtocolEvidenceAllowance = "no-run" | "error" | "cancel";

export type ProtocolEvidence = {
  /** Enabled-lane integration ids of the Dojo pages the test opened. */
  lanes: readonly string[];
  /** Every AG-UI stream of the test, in the order the requests were sent. */
  streams: readonly ProtocolStream[];
  /** User turns the chat showed at the end of the test. */
  prompts: number;
  allowances: ReadonlySet<ProtocolEvidenceAllowance>;
};

/**
 * The prompt a run request answers: the id of the latest user message in its
 * body (the content when the message has no id), or undefined when the body
 * carries no user message. Run requests carry the whole conversation as
 * `messages`, at the top level or nested (CopilotKit's single-route transport
 * wraps the run input in an envelope).
 */
export function promptKeyOfRequest(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const messages = findMessages(parsed, 0);
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Record<string, unknown> | null;
    if (message && typeof message === "object" && message.role === "user") {
      return typeof message.id === "string" && message.id
        ? `id:${message.id}`
        : `content:${JSON.stringify(message.content)}`;
    }
  }
  return undefined;
}

/**
 * The SSE text up to the last complete frame. A stream cut off by a
 * cancellation or failure can end mid-event; every event that arrived whole is
 * still judged, the fragment is not.
 */
export function completeFrames(body: string): string {
  const normalized = body.replaceAll("\r\n", "\n");
  const end = normalized.lastIndexOf("\n\n");
  return end === -1 ? "" : normalized.slice(0, end + 2);
}

function findMessages(value: unknown, depth: number): unknown[] | undefined {
  if (depth > 4 || !value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.messages)) return record.messages;
  for (const child of Object.values(record)) {
    const found = findMessages(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Every reason the test's protocol evidence falls short, as messages naming
 * what was expected and what was observed. Empty when the evidence holds.
 *
 * - Every RUN_STARTED received must declare the version, including one that
 *   arrived before the stream was cancelled or failed.
 * - Every prompt needs a run of its own. Runs are deduplicated by runId
 *   across all streams in request order, so a run counts for the first prompt
 *   it answered: an earlier prompt's extra runs, or a replay of its run in
 *   another response, cannot cover a later prompt.
 * - A stream that failed for any reason other than the page cancelling it is
 *   a failure.
 */
export function findProtocolEvidenceProblems(
  evidence: ProtocolEvidence,
  expected: string = EXPECTED_PROTOCOL_VERSION,
): string[] {
  const { lanes, streams, prompts, allowances } = evidence;
  if (lanes.length === 0 && streams.length === 0) return [];
  const problems: string[] = [];
  const lane = lanes[0] ?? streams[0]?.lane;
  const seenRuns = new Set<string>();
  // Prompts in the order their first request was sent, with what answered them.
  const answered = new Map<string, boolean>();
  let anyAnswer = false;

  for (const stream of streams) {
    if (stream.promptKey !== undefined && !answered.has(stream.promptKey)) {
      answered.set(stream.promptKey, false);
    }
    if (stream.outcome === "failed") {
      problems.push(
        `[${stream.lane}] ${stream.url}: reading the response failed (${stream.error ?? "unknown error"}); expected a complete run`,
      );
    }
    const events = parseEventTraceSse(
      stream.outcome === "complete" ? stream.body : completeFrames(stream.body),
    );
    for (const violation of findProtocolVersionViolations(events, expected)) {
      problems.push(
        `[${stream.lane}] run ${violation.runId} at ${stream.url}: RUN_STARTED.protocolVersion is ${JSON.stringify(violation.protocolVersion)}, expected ${JSON.stringify(expected)}`,
      );
    }
    const started = events
      .filter((event) => event.type === "RUN_STARTED")
      .map((event, i) => String(event.runId ?? `<missing runId #${i}>`));
    const fresh = started.filter((runId) => !seenRuns.has(runId));
    for (const runId of started) seenRuns.add(runId);

    // What answers this stream's prompt: a run no earlier stream already
    // showed; a RUN_ERROR-only stream in a test that provokes errors; or, in a
    // test that cancels, a stream the page aborted before any run started (a
    // stream that did start a run is judged by that run above).
    const answers =
      fresh.length > 0 ||
      (started.length === 0 &&
        allowances.has("error") &&
        events.some((event) => event.type === "RUN_ERROR")) ||
      (started.length === 0 && allowances.has("cancel") && stream.outcome === "aborted");
    if (!answers) continue;
    anyAnswer = true;
    if (stream.promptKey !== undefined) answered.set(stream.promptKey, true);
  }

  if (!allowances.has("no-run")) {
    if (!anyAnswer) {
      problems.push(`[${lane}] no AG-UI run was observed; expected at least one`);
    }
    [...answered.values()].forEach((ok, index) => {
      if (!ok) {
        problems.push(
          `[${lane}] prompt ${index + 1} of ${answered.size} got no run of its own; each prompt needs a new run (an earlier prompt's runs, or a replay of one, do not count)`,
        );
      }
    });
    if (answered.size < prompts) {
      problems.push(
        `[${lane}] the chat shows ${prompts} prompt(s) but only ${answered.size} run request(s) carried one; each prompt needs its own run`,
      );
    }
  }
  return problems;
}

/** Throws with every problem {@link findProtocolEvidenceProblems} finds. */
export function assertProtocolEvidence(
  evidence: ProtocolEvidence,
  expected: string = EXPECTED_PROTOCOL_VERSION,
) {
  const problems = findProtocolEvidenceProblems(evidence, expected);
  if (problems.length > 0) {
    throw new Error(
      `AG-UI protocol check (version ${expected}) failed:\n${problems.join("\n")}`,
    );
  }
}
