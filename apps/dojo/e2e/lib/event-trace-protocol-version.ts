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
  // ag2 (ag2.ag_ui) declares PROTOCOL_VERSION on RUN_STARTED from 1.1.2.
  "ag2",
  // ag_ui_agentspec declares PROTOCOL_VERSION on RUN_STARTED (both runtimes).
  "agent-spec-langgraph",
  "agent-spec-wayflow",
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

/**
 * Throws when any captured stream's runs fail to declare the expected
 * version. A test that never starts a run (a pure render check, say)
 * legitimately checks nothing.
 */
export function assertStreamsDeclareProtocolVersion(
  streams: readonly CapturedProtocolStream[],
  expected: string = EXPECTED_PROTOCOL_VERSION,
) {
  const failures: string[] = [];
  for (const stream of streams) {
    const events = parseEventTraceSse(stream.body);
    for (const violation of findProtocolVersionViolations(events, expected)) {
      failures.push(
        `[${stream.lane}] run ${violation.runId} at ${stream.url}: RUN_STARTED.protocolVersion is ${JSON.stringify(violation.protocolVersion)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `AG-UI producer did not declare protocol version ${expected}:\n${failures.join("\n")}`,
    );
  }
}
