import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { readRunAgentInput } from "./input";
import { runAGUI, type AGUIRunHandler, type AGUIState, type ApprovalStore, type StateStore } from "./run";

export interface HandleAGUIRequestOptions<State = AGUIState> {
  /** Where shared state lives. Defaults to the state in the request. */
  state?: StateStore<State>;
  /**
   * Where paused approvals are recorded (KV, D1, a Durable Object), so a
   * resume can only approve calls the model made. Without it, or AI SDK's
   * `experimental_toolApprovalSecret`, a resume trusts the client's history.
   */
  approvals?: ApprovalStore;
  /** Extra response headers (CORS, for instance). */
  headers?: HeadersInit;
}

/**
 * Serves one AG-UI run over HTTP: reads the `RunAgentInput` POSTed by an
 * AG-UI client (such as `HttpAgent`), calls `handler`, and streams the run
 * back as Server-Sent Events.
 *
 * ```ts
 * export default {
 *   fetch: (request, env) =>
 *     handleAGUIRequest(request, (run) =>
 *       streamText({
 *         model: workersai("@cf/meta/llama-4-scout-17b-16e-instruct"),
 *         ...run.streamTextOptions({ instructions: "You are a helpful assistant." }),
 *       }),
 *     ),
 * };
 * ```
 */
export async function handleAGUIRequest<State = AGUIState>(
  request: Request,
  handler: AGUIRunHandler<State>,
  options: HandleAGUIRequestOptions<State> = {},
): Promise<Response> {
  const headers = (extra?: HeadersInit) => {
    const merged = new Headers(options.headers);
    new Headers(extra).forEach((value, key) => merged.set(key, value));
    return merged;
  };
  if (request.method === "OPTIONS") {
    // A CORS preflight; `options.headers` carries the CORS headers.
    return new Response(null, { status: 204, headers: headers({ Allow: "POST, OPTIONS" }) });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: headers({ Allow: "POST, OPTIONS" }) });
  }
  let input: RunAgentInput;
  try {
    input = parseRunAgentInput(await request.json());
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Invalid request body", {
      status: 400,
      headers: headers(),
    });
  }

  const controller = new AbortController();
  const signal = anySignal([request.signal, controller.signal]);
  const events = runAGUI(input, handler, {
    signal,
    state: options.state,
    approvals: options.approvals,
    request,
  });
  return eventStreamResponse(events, {
    headers: options.headers,
    onCancel: () => controller.abort(),
  });
}

/**
 * Lets an AG-UI client that posts every thread to one URL (a plain
 * `HttpAgent`) reach the thread's agent: a run POSTed to `/agents/<agent>` is
 * re-addressed to `/agents/<agent>/<threadId>`, the path the Agents SDK's
 * `routeAgentRequest` maps to that thread's Durable Object. Anything else is
 * returned unchanged.
 *
 * ```ts
 * fetch: async (request, env) =>
 *   (await routeAgentRequest(await toThreadRequest(request), env)) ??
 *   new Response("Not found", { status: 404 }),
 * ```
 */
export async function toThreadRequest(
  request: Request,
  options: { prefix?: string } = {},
): Promise<Request> {
  if (!isAGUIRequest(request)) return request;
  const url = new URL(request.url);
  const prefix = (options.prefix ?? "agents").replace(/^\/+|\/+$/g, "");
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== prefix) return request;

  const body = await request.text();
  let threadId: unknown;
  try {
    threadId = (JSON.parse(body) as { threadId?: unknown }).threadId;
  } catch {
    threadId = undefined;
  }
  const init = { method: request.method, headers: request.headers, body, signal: request.signal };
  if (typeof threadId !== "string" || !threadId) return new Request(request.url, init);
  url.pathname = `/${prefix}/${segments[1]}/${encodeURIComponent(threadId)}`;
  return new Request(url, init);
}

/** True for a POST that asks for an event stream, as AG-UI's `HttpAgent` sends. */
export function isAGUIRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/event-stream");
}

/**
 * Reads a request body as a `RunAgentInput`, as AG-UI requires of an agent:
 * members the protocol does not define are removed with a warning, a missing
 * or malformed known field throws (answer it with a 400), and the optional
 * fields are filled so handlers can rely on arrays being arrays.
 */
export function parseRunAgentInput(body: unknown): RunAgentInput {
  return readRunAgentInput(body);
}

/** Streams AG-UI events as a `text/event-stream` response. */
export function eventStreamResponse(
  events: AsyncIterable<BaseEvent>,
  options: { headers?: HeadersInit; onCancel?: () => void } = {},
): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      // Abort first: the generator may be waiting on the model, and only
      // finishes (running its cleanup) once the stream it reads ends.
      options.onCancel?.();
      void iterator.return?.(undefined);
    },
  });
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  return new Response(body, { headers });
}

function anySignal(signals: Array<AbortSignal | undefined | null>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => !!signal);
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (any) return any(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
