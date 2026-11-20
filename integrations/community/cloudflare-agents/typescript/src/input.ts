import { PROTOCOL_VERSION, enforceOutgoingInput, type RunAgentInput } from "@ag-ui/client";

/** A `RunAgentInput` the protocol rejects: a required field is missing, or a known field is malformed. */
export class InvalidInputError extends Error {
  override name = "InvalidInputError";
}

/** Inputs this module has already read, so a run does not check its input twice. */
const read = new WeakSet<object>();

/**
 * Reads a `RunAgentInput` the way AG-UI requires of an agent: members the
 * protocol does not define are removed (with a warning), a known field with a
 * malformed value rejects the input, and the optional fields are filled so
 * handlers can rely on arrays being arrays. Throws `InvalidInputError`.
 */
export function readRunAgentInput(body: unknown): RunAgentInput {
  if (typeof body === "object" && body !== null && read.has(body)) return body as RunAgentInput;
  if (typeof body !== "object" || body === null) throw new InvalidInputError("Expected a RunAgentInput object");
  const raw = body as Partial<RunAgentInput>;
  if (typeof raw.threadId !== "string" || !raw.threadId) throw new InvalidInputError("threadId is required");
  if (typeof raw.runId !== "string" || !raw.runId) throw new InvalidInputError("runId is required");
  if (!Array.isArray(raw.messages)) throw new InvalidInputError("messages must be an array");

  let checked: RunAgentInput;
  try {
    checked = enforceOutgoingInput(raw as RunAgentInput);
  } catch (error) {
    throw new InvalidInputError(`Invalid RunAgentInput: ${describeError(error)}`);
  }
  const input: RunAgentInput = {
    ...checked,
    tools: checked.tools ?? [],
    context: checked.context ?? [],
    state: checked.state ?? {},
    forwardedProps: checked.forwardedProps ?? {},
  };
  read.add(input);
  return input;
}

/**
 * Warns when the client declares a newer AG-UI version than this package
 * speaks (or one it cannot read). The run is served either way, in this
 * package's version.
 */
export function warnAboutProtocolVersion(version: string | undefined): void {
  if (!version) return;
  const theirs = parseVersion(version);
  const ours = parseVersion(PROTOCOL_VERSION);
  if (theirs && ours && compareVersions(theirs, ours) <= 0) return;
  warn(`The client speaks AG-UI ${version}; this agent speaks ${PROTOCOL_VERSION} and serves the run in that version.`);
}

/** Logs something the protocol asks an agent to warn about. */
export function warn(message: string): void {
  console.warn(`[ag-ui][cloudflare-agents] ${message}`);
}

function parseVersion(version: string): [number, number] | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function compareVersions(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

function describeError(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .slice(0, 5)
      .map((issue: { path?: unknown[]; message?: string }) => {
        const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(input)";
        return `${path}: ${issue.message ?? "invalid"}`;
      })
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
