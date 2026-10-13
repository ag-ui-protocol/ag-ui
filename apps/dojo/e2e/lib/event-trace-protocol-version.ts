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

export type CapturedProtocolStream = {
  lane: string;
  url: string;
  body: string;
};

/** A response the check could not read, kept so the failure has its cause. */
export type UnreadableProtocolStream = {
  lane: string;
  url: string;
  error: string;
};

/**
 * What a test declares about runs it does not expect to complete normally.
 * Each needs a reason, so a passing spec never looks like conformance evidence
 * it did not produce.
 *
 * - `no-run`: the test only renders or inspects the page and starts no run.
 * - `error`: the test provokes an error; a stream may end in RUN_ERROR before
 *   any RUN_STARTED.
 * - `cancel`: the test cancels a run, so that stream's body may be unreadable.
 */
export type ProtocolEvidenceAllowance = "no-run" | "error" | "cancel";

export type ProtocolEvidence = {
  /** Enabled-lane integration ids of the Dojo pages the test opened. */
  lanes: readonly string[];
  streams: ReadonlyArray<CapturedProtocolStream | UnreadableProtocolStream>;
  /** User turns the chat showed at the end of the test. */
  prompts: number;
  allowances: ReadonlySet<ProtocolEvidenceAllowance>;
};

/**
 * Every reason the test's protocol evidence falls short, as messages naming
 * what was expected and what was observed. Empty when the evidence holds.
 *
 * Beyond the version declaration itself: each prompt needs a run of its own
 * (an earlier run cannot stand in for a later prompt, and a stream that
 * started no run is not one), and an unreadable response is a failure, unless
 * the test declared the matching allowance.
 */
export function findProtocolEvidenceProblems(
  evidence: ProtocolEvidence,
  expected: string = EXPECTED_PROTOCOL_VERSION,
): string[] {
  const { lanes, streams, prompts, allowances } = evidence;
  if (lanes.length === 0 && streams.length === 0) return [];
  const problems: string[] = [];
  let runs = 0;
  let errorStreams = 0;

  for (const stream of streams) {
    if ("error" in stream) {
      if (!allowances.has("cancel")) {
        problems.push(
          `[${stream.lane}] ${stream.url}: the response body could not be read (${stream.error}); expected a readable run`,
        );
      }
      continue;
    }
    const events = parseEventTraceSse(stream.body);
    const started = new Set(
      events
        .filter((event) => event.type === "RUN_STARTED")
        .map((event, i) => String(event.runId ?? `<missing runId #${i}>`)),
    );
    runs += started.size;
    for (const violation of findProtocolVersionViolations(events, expected)) {
      problems.push(
        `[${stream.lane}] run ${violation.runId} at ${stream.url}: RUN_STARTED.protocolVersion is ${JSON.stringify(violation.protocolVersion)}, expected ${JSON.stringify(expected)}`,
      );
    }
    // A stream that started no run is not evidence of one. CopilotKit also
    // opens such streams on its own (an empty reconnect, say), so it is not a
    // failure by itself; a prompt left with only that fails the count below.
    // An error test's RUN_ERROR-only stream stands in for its prompt's run.
    if (
      started.size === 0 &&
      allowances.has("error") &&
      events.some((event) => event.type === "RUN_ERROR")
    ) {
      errorStreams += 1;
    }
  }

  if (!allowances.has("no-run")) {
    const lane = lanes[0] ?? streams[0]?.lane;
    if (runs + errorStreams === 0) {
      problems.push(`[${lane}] no AG-UI run was observed; expected at least one`);
    } else if (runs + errorStreams < prompts) {
      problems.push(
        `[${lane}] ${prompts} prompt(s) were sent but only ${runs + errorStreams} run(s) started; each prompt needs its own run`,
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
