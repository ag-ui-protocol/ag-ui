import { isDeepStrictEqual } from "node:util";

export type TraceEvent = {
  type: string;
  [field: string]: unknown;
};

export class EventTraceSseParseError extends Error {
  constructor(
    message: string,
    readonly responseBody: string,
    readonly frameIndex: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EventTraceSseParseError";
  }
}

const GENERATED_ID_FIELDS = new Set([
  "checkpointId",
  "messageId",
  "parentMessageId",
  "parentToolCallId",
  "parentRunId",
  "runId",
  "threadId",
  "toolCallId",
  "checkpoint_id",
  "langgraph_request_id",
  "message_id",
  "originalAIMessageId",
  "original_ai_message_id",
  "parent_message_id",
  "parent_tool_call_id",
  "parent_run_id",
  "run_id",
  "requestId",
  "thread_id",
  "tool_call_id",
]);

const STRUCTURED_ID_FIELDS = new Set([
  "checkpoint_ns",
  "langgraph_checkpoint_ns",
  "subagentRunId",
  "subagent_run_id",
]);

const GENERATED_ID_ARRAY_FIELDS = new Set([
  "interruptIds",
  "interrupt_ids",
  "parentIds",
  "parent_ids",
]);
// Keys MUST be lowercase: normalizeForwardedHeaders looks them up by the
// lowercased header name, so a title-cased key here would never match.
const FORWARDED_HEADER_TOKENS = new Map([
  ["x-forwarded-for", "<forwarded-for>"],
  ["x-forwarded-host", "<forwarded-host>"],
  ["x-forwarded-port", "<forwarded-port>"],
  ["x-forwarded-proto", "<forwarded-proto>"],
]);
const APP_CONTEXT_PREFIX = "App Context:\n";

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CANONICAL_ID_PATTERN = /\bid-\d+\b/g;
const EXACT_CANONICAL_ID_PATTERN = /^id-\d+$/;

export function isTraceEvent(value: unknown): value is TraceEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function parseDataFrame(
  data: string,
  responseBody: string,
  frameIndex: number,
): TraceEvent {
  let value: unknown;

  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new EventTraceSseParseError(
      `Invalid AG-UI SSE data frame ${frameIndex}: ${data}`,
      responseBody,
      frameIndex,
      { cause: error },
    );
  }

  if (!isTraceEvent(value)) {
    throw new EventTraceSseParseError(
      `AG-UI SSE data frame ${frameIndex} is missing a string type: ${data}`,
      responseBody,
      frameIndex,
    );
  }

  return value;
}

/** Parse the data frames from one complete AG-UI SSE response body. */
export function parseEventTraceSse(body: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  let dataLines: string[] = [];
  let frameIndex = 0;

  const flushFrame = () => {
    if (dataLines.length === 0) return;

    const data = dataLines.join("\n");
    dataLines = [];
    if (data.trim().length === 0) return;

    const event = parseDataFrame(data, body, frameIndex);
    if (event.type !== "RAW") events.push(event);
    frameIndex += 1;
  };

  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    if (line === "") {
      flushFrame();
      continue;
    }

    if (line === "data") {
      dataLines.push("");
      continue;
    }

    if (line.startsWith("data:")) {
      const data = line.slice(5);
      dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
    }
  }

  flushFrame();
  return events;
}

function isGeneratedIdentityField(key: string, path: readonly string[]) {
  if (GENERATED_ID_FIELDS.has(key)) return true;
  if (key !== "id") return false;

  return path.some(
    (segment) =>
      segment === "messages" ||
      segment === "interceptedToolCalls" ||
      segment === "toolCalls" ||
      segment === "tool_calls",
  );
}

// The predicate, not an inline `typeof` chain, is what lets the callee declare
// a `Record<string, unknown>` parameter at all: reading the bag through
// `Reflect.get` hands back `any`, which satisfies any parameter type and let an
// array through unchecked, while an inline chain over `unknown` narrows only as
// far as `object` and would not typecheck at the call site.
//
// All three clauses are load-bearing at runtime, not just for narrowing:
// `typeof null === "object"`, so dropping the null check makes this accept
// `null`, and dropping the `typeof` check makes it accept a string — both of
// which `Object.entries` then reshapes or throws on.
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `copilotkit_forwarded_headers` keys carry whatever spelling reached the agent.
// The producer builds the bag by matching the `x-` prefix case-insensitively and
// then emits each key verbatim, and a caller can put the key in
// `config.configurable` themselves, so nothing upstream promises lowercase. Field names are case-insensitive (RFC 9110
// §5.1), so match on the lowercased name — an upstream spelling change must not
// turn a stable trace into an environment-dependent one.
//
// An entry the map does not name keeps its spelling and its value. That set is
// open — the producer forwards every `x-` header verbatim — so an unnamed one
// carrying a per-request value (`x-request-id`, `x-amzn-trace-id`) would churn
// every golden it appears in. The remedy is to name it in
// FORWARDED_HEADER_TOKENS, not to widen the match. Two spellings of one named
// header collapse into a single entry, which is correct — they are the same
// field, and how many hops spelled it is environment metadata too.
function normalizeForwardedHeaders(
  headers: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([header, value]): [string, unknown] => {
      const lowercasedHeader = header.toLowerCase();
      const token = FORWARDED_HEADER_TOKENS.get(lowercasedHeader);
      return token === undefined ? [header, value] : [lowercasedHeader, token];
    }),
  );
}

function normalizeAppContextContent(
  value: string,
  normalizeIdentity: (value: string) => string,
) {
  if (!value.startsWith(APP_CONTEXT_PREFIX)) return value;

  let context: unknown;
  try {
    context = JSON.parse(value.slice(APP_CONTEXT_PREFIX.length));
  } catch {
    // This is ordinary message content unless it is valid App Context JSON.
    // Only the parse is guarded: a bug in the rewrite below must surface, not
    // degrade into silently unnormalized content.
    return value;
  }

  if (!isPlainRecord(context)) return value;
  let normalized = false;
  if (typeof context.thread_id === "string") {
    context.thread_id = normalizeIdentity(context.thread_id);
    normalized = true;
  }

  const headers = context.copilotkit_forwarded_headers;
  // Neither the presence nor the shape of this key is ours to assume: it is
  // absent until an `x-` header arrives, and a caller can put any JSON value
  // there. This guard keeps Object.entries from throwing or reshaping a
  // primitive/array bag. If no recognized App Context field was normalized,
  // return the original string byte-for-byte.
  if (isPlainRecord(headers)) {
    context.copilotkit_forwarded_headers = normalizeForwardedHeaders(headers);
    normalized = true;
  }

  if (!normalized) return value;
  return `${APP_CONTEXT_PREFIX}${JSON.stringify(context, null, 2)}`;
}

function collapseStateSnapshotPulses(events: TraceEvent[]) {
  const collapsed: TraceEvent[] = [];
  let lastSnapshot: TraceEvent | undefined;

  for (const event of events) {
    if (event.type === "RUN_STARTED" || event.type === "STATE_DELTA") {
      lastSnapshot = undefined;
    }

    if (event.type === "STATE_SNAPSHOT") {
      if (lastSnapshot && isDeepStrictEqual(lastSnapshot, event)) continue;
      lastSnapshot = event;
    }

    collapsed.push(event);
  }

  return collapsed;
}

/**
 * Remove unstable transport metadata and replace generated identities with stable,
 * first-seen tokens while retaining references between events.
 */
export function normalizeEventTrace(
  events: readonly TraceEvent[],
): TraceEvent[] {
  const identities = new Map<string, string>();
  const reservedIdentityTokens = new Set<string>();
  let nextIdentity = 1;

  const reserveCanonicalIdentityTokens = (
    value: unknown,
    path: readonly string[],
  ) => {
    if (typeof value === "string") {
      for (const token of value.matchAll(CANONICAL_ID_PATTERN)) {
        reservedIdentityTokens.add(token[0]);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) reserveCanonicalIdentityTokens(child, path);
      return;
    }
    if (typeof value !== "object" || value === null) return;

    for (const [key, child] of Object.entries(value)) {
      if (key === "rawEvent" && path.length === 0) continue;
      reserveCanonicalIdentityTokens(child, [...path, key]);
    }
  };

  reserveCanonicalIdentityTokens(events, []);

  const normalizeIdentity = (value: string) => {
    if (EXACT_CANONICAL_ID_PATTERN.test(value)) return value;
    const existing = identities.get(value);
    if (existing) return existing;

    let token = `id-${nextIdentity}`;
    while (reservedIdentityTokens.has(token)) {
      nextIdentity += 1;
      token = `id-${nextIdentity}`;
    }
    nextIdentity += 1;
    reservedIdentityTokens.add(token);
    identities.set(value, token);
    return token;
  };

  const normalizeStructuredIdentity = (value: string) => {
    return value.replace(UUID_PATTERN, (uuid) =>
      normalizeIdentity(uuid.toLowerCase()),
    );
  };

  const normalizeValue = (value: unknown, path: readonly string[]): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeValue(item, path));
    }

    if (typeof value !== "object" || value === null) return value;

    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) => {
        if (key === "rawEvent" && path.length === 0) return [];
        if (key === "timestamp" && path.length === 0) return [];
        if (
          key === "created_at" &&
          path.at(-1) === "response_metadata" &&
          typeof Reflect.get(value, "model_provider") === "string"
        ) {
          return [];
        }

        const nextPath = [...path, key];
        let normalized: unknown;
        if (Array.isArray(child) && GENERATED_ID_ARRAY_FIELDS.has(key)) {
          normalized = child.map((identity) =>
            typeof identity === "string"
              ? normalizeIdentity(identity)
              : normalizeValue(identity, nextPath),
          );
        } else if (typeof child !== "string") {
          normalized = normalizeValue(child, nextPath);
        } else if (STRUCTURED_ID_FIELDS.has(key)) {
          normalized = normalizeStructuredIdentity(child);
        } else if (isGeneratedIdentityField(key, path)) {
          normalized = normalizeIdentity(child);
        } else if (key === "content") {
          normalized = normalizeAppContextContent(child, normalizeIdentity);
        } else {
          normalized = child;
        }

        return [[key, normalized]];
      }),
    );
  };

  const normalized = events.map((event) => {
    const normalized = normalizeValue(event, []);
    if (!isTraceEvent(normalized)) {
      throw new Error("Normalized AG-UI event lost its type");
    }
    return normalized;
  });

  return collapseStateSnapshotPulses(normalized);
}
