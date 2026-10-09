// A scripted stand-in for the Claude Managed Agents API (the `beta.agents` and
// `beta.sessions` endpoints the adapters call), mounted on aimock.
//
// aimock fakes model APIs (`/v1/messages` and friends) by matching a request to
// a canned response. Managed Agents is not a model API: it is a hosted agent
// runtime with server-side sessions, a long-lived SSE event stream per session,
// and events posted into it out of band. None of that fits aimock's fixture
// matching, so the three Claude Managed Agents Dojo lanes (Python, TypeScript,
// .NET) are served by this handler instead, through aimock's `mount()` hook.
//
// It implements just enough of the API for the Dojo examples:
//   - GET  /v1/agents/{id}                   (the tool list an override session merges with)
//   - POST /v1/sessions, GET/POST /v1/sessions/{id}
//   - GET  /v1/sessions/{id}/events/stream   (SSE, `event: <type>` frames)
//   - POST /v1/sessions/{id}/events          (user.message, user.custom_tool_result, ...)
//
// Each session remembers what the user told it, so the agentic-chat memory
// tests exercise the adapters' thread→session mapping for real: a reply can
// only recall "Alex" if the adapter kept posting into the same session.
//
// The feature behind a session is read from its agent id. Keyless Dojo runs
// skip provisioning and load apps/dojo/e2e/fixtures/claude-managed-agents/ids.json,
// whose ids are `agent_fake_<feature>`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/** The slice of aimock's `Mountable` this handler implements. */
interface ManagedAgentsMount {
  handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
}

/** The slice of `LLMock` this module needs. */
interface MountTarget {
  mount(path: string, handler: ManagedAgentsMount): unknown;
}

type Json = Record<string, unknown>;

interface Session {
  id: string;
  agentId: string;
  feature: string;
  /** Every user message text posted into the session, oldest first. */
  userTexts: string[];
  /** Open event streams; every emitted event goes to all of them. */
  streams: Set<ServerResponse>;
  /** Custom tool calls the session is waiting on, by id → tool name. */
  awaiting: Map<string, string>;
  /** Awaited calls whose results arrived; the session un-parks shortly after. */
  resumed: Set<string>;
  /** Events posted since the session last answered, played as one turn. */
  pending: Json[];
  turnTimer?: ReturnType<typeof setTimeout>;
}

const FAKE_AGENT_PREFIX = "agent_fake_";

/** How long the reply to a tool result takes; longer than the adapters' first parked retry (150 ms). */
const TOOL_RESULT_REPLY_MS = 400;

const HAIKU_FIXTURES_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "openai",
  "tool-based-gen-ui.json",
);

interface HaikuFixture {
  match: { userMessage: string };
  response: { toolCalls: { name: string; arguments: string }[] };
}

/** The haiku arguments the other lanes' fixtures already use, keyed by prompt fragment. */
const loadHaikus = (): HaikuFixture[] =>
  (JSON.parse(readFileSync(HAIKU_FIXTURES_PATH, "utf-8")) as { fixtures: HaikuFixture[] }).fixtures;

/** The Dojo feature a managed agent id stands for. */
const featureOf = (agentId: string): string =>
  agentId.startsWith(FAKE_AGENT_PREFIX) ? agentId.slice(FAKE_AGENT_PREFIX.length) : agentId;

const now = () => new Date().toISOString();

class ManagedAgentsFake {
  private readonly sessions = new Map<string, Session>();
  private readonly haikus = loadHaikus();
  private counter = 0;

  /** `prefix` is the path this instance is mounted at, e.g. `/v1/sessions`. */
  forPrefix(prefix: string): ManagedAgentsMount {
    return {
      handleRequest: (req, res, subPath) =>
        this.route(req, res, `${prefix}${subPath === "/" ? "" : subPath}`),
    };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter.toString().padStart(6, "0")}`;
  }

  private async route(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const method = req.method ?? "GET";
    const parts = pathname.split("/").filter(Boolean); // ["v1", "sessions", id, "events", "stream"]
    if (parts[0] !== "v1") return false;
    const [, resource, id, sub, subSub] = parts;

    try {
      if (resource === "agents") {
        // The adapters only read an agent back, for its tool list, and the
        // keyless lanes never provision, so every id resolves to an agent
        // with no tools.
        return id && method === "GET" ? sendJson(res, 200, agentJson(id)) : false;
      }
      if (resource !== "sessions") return false;

      if (!id) {
        if (method !== "POST") return false;
        const body = await readJson(req);
        return sendJson(res, 200, this.createSession(body));
      }
      const session = this.sessions.get(id);
      if (!session) {
        return sendJson(res, 404, {
          type: "error",
          error: { type: "not_found_error", message: `No session ${id}.` },
        });
      }
      if (!sub) {
        if (method === "POST") await readJson(req); // tool updates: nothing to keep
        return sendJson(res, 200, this.sessionJson(session));
      }
      if (sub === "events" && subSub === "stream" && method === "GET") {
        this.openStream(session, req, res);
        return true;
      }
      if (sub === "events" && !subSub && method === "POST") {
        const body = await readJson(req);
        const events = Array.isArray(body.events) ? (body.events as Json[]) : [];
        // Like the real API, a parked session takes no user message until the
        // tool calls it waits on are answered and it has resumed (which, as in
        // the real session, happens just after the result is sent). Accepting
        // one would let a lane pass even when the adapter never delivered the
        // tool result. The adapters retry on this exact wording.
        const rejection = parkedRejection(session, events);
        if (rejection) {
          return sendJson(res, 400, {
            type: "error",
            error: { type: "invalid_request_error", message: rejection },
          });
        }
        const stamped = events.map((event) => ({ ...event, id: this.nextId("sevt_"), processed_at: now() }));
        sendJson(res, 200, { data: stamped });
        this.schedule(session, events);
        return true;
      }
      return false;
    } catch (error) {
      return sendJson(res, 500, {
        type: "error",
        error: { type: "api_error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private createSession(body: Json): Json {
    const agent = body.agent as Json | string | undefined;
    const agentId =
      typeof agent === "string" ? agent : typeof agent?.id === "string" ? agent.id : "agent_unknown";
    const session: Session = {
      id: this.nextId("sesn_fake_"),
      agentId,
      feature: featureOf(agentId),
      userTexts: [],
      streams: new Set(),
      awaiting: new Map(),
      resumed: new Set(),
      pending: [],
    };
    this.sessions.set(session.id, session);
    return this.sessionJson(session);
  }

  private sessionJson(session: Session): Json {
    return {
      id: session.id,
      type: "session",
      status: "idle",
      agent: { type: "agent", id: session.agentId },
      created_at: now(),
      updated_at: now(),
    };
  }

  private openStream(session: Session, req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    session.streams.add(res);
    const close = () => session.streams.delete(res);
    req.on("close", close);
    res.on("close", close);
  }

  private emit(session: Session, event: Json): void {
    const stamped: Json = { id: this.nextId("sevt_"), processed_at: now(), ...event };
    const frame = `event: ${String(stamped.type)}\ndata: ${JSON.stringify(stamped)}\n\n`;
    for (const stream of session.streams) stream.write(frame);
  }

  private say(session: Session, text: string): void {
    this.emit(session, { type: "agent.message", content: [{ type: "text", text }] });
  }

  private idle(session: Session, stopReason: Json): void {
    this.emit(session, { type: "session.status_idle", stop_reason: stopReason });
  }

  private callTool(session: Session, name: string, input: unknown): void {
    const id = this.nextId("sevt_");
    session.awaiting.set(id, name);
    this.emit(session, { id, type: "agent.custom_tool_use", name, input });
    this.idle(session, { type: "requires_action", event_ids: [id] });
  }

  /**
   * Answer after the send has returned, as the real session does: the reply
   * arrives on the stream, never in the send's response. A tool result
   * un-parks the session right away but its reply takes a moment, like a
   * model call, and a user message sent in that window joins the same turn.
   * The adapters post results and messages separately (retrying the message
   * while the session un-parks), so without that window the reply to the
   * results would end the turn and the message's reply would land after it.
   */
  private schedule(session: Session, events: Json[]): void {
    session.pending.push(...events);
    const results = events.filter((event) => event.type === "user.custom_tool_result");
    if (results.length > 0) {
      setTimeout(() => {
        for (const event of results) session.resumed.add(String(event.custom_tool_use_id ?? ""));
      }, 5);
    }
    clearTimeout(session.turnTimer);
    const hasMessage = events.some((event) => event.type === "user.message");
    session.turnTimer = setTimeout(() => {
      const batch = session.pending;
      session.pending = [];
      this.react(session, batch);
    }, hasMessage ? 5 : TOOL_RESULT_REPLY_MS);
  }

  /** Play the session's side of the conversation for the events just posted. */
  private react(session: Session, events: Json[]): void {
    this.emit(session, { type: "session.status_running" });
    let answeredTool: string | undefined;
    const newTexts: string[] = [];
    for (const event of events) {
      if (event.type === "user.message") {
        const text = textOf(event.content);
        session.userTexts.push(text);
        newTexts.push(text);
      } else if (event.type === "user.custom_tool_result") {
        const toolUseId = String(event.custom_tool_use_id ?? "");
        answeredTool = session.awaiting.get(toolUseId) ?? answeredTool;
        session.awaiting.delete(toolUseId);
        session.resumed.delete(toolUseId);
      } else if (event.type === "user.interrupt") {
        session.awaiting.clear();
        session.resumed.clear();
        this.idle(session, { type: "end_turn" });
        return;
      }
    }

    // Still waiting on another custom tool: stay parked until it is answered.
    if (newTexts.length === 0 && session.awaiting.size > 0) {
      this.idle(session, { type: "requires_action", event_ids: [...session.awaiting.keys()] });
      return;
    }

    const latest = newTexts.at(-1);
    if (latest === undefined) {
      this.say(session, toolFollowUp(answeredTool));
      this.idle(session, { type: "end_turn" });
      return;
    }

    switch (session.feature) {
      case "backend_tool_rendering": {
        // "What's the weather like in San Francisco?" (the Dojo suggestion),
        // "weather in Paris", "weather for Tokyo".
        const city = cityOf(latest);
        if (city) return this.callTool(session, "get_weather", { location: city });
        break;
      }
      case "tool_based_generative_ui": {
        const haiku = this.haikus.find((fixture) => latest.includes(fixture.match.userMessage));
        const call = haiku?.response.toolCalls[0] ?? this.haikus[0]?.response.toolCalls[0];
        if (call && /haiku/i.test(latest)) return this.callTool(session, call.name, JSON.parse(call.arguments));
        break;
      }
      case "human_in_the_loop": {
        if (/plan/i.test(latest)) return this.callTool(session, "generate_task_steps", { steps: MARS_PLAN });
        break;
      }
    }

    this.say(session, chatReply(session.userTexts, latest));
    this.idle(session, { type: "end_turn" });
  }
}

/** The real API's refusal of a user message sent to a parked session, if this send is one. */
const parkedRejection = (session: Session, events: Json[]): string | undefined => {
  const waiting = [...session.awaiting.keys()].filter((id) => !session.resumed.has(id));
  return waiting.length > 0 && events.some((event) => event.type === "user.message")
    ? `session is waiting on responses to events [${waiting.join(", ")}]`
    : undefined;
};

/** A deterministic chat reply that recalls what the user said earlier in the session. */
const chatReply = (history: string[], latest: string): string => {
  const recall = (pattern: RegExp): string | undefined => {
    for (const text of [...history].reverse()) {
      const match = pattern.exec(text);
      if (match) return match[1]!.trim();
    }
    return undefined;
  };
  if (/what is my name/i.test(latest)) {
    const name = recall(/my name is ([A-Za-z]+)/i);
    return name ? `Your name is ${name}.` : "You have not told me your name yet.";
  }
  if (/^(hi|hello|hey)\b/i.test(latest.trim()) && latest.trim().length < 12) {
    return "Hello! How can I help you today?";
  }
  return `Hello! You said: ${latest}`;
};

/** The city a weather question asks about, if it is one. */
const cityOf = (text: string): string | undefined =>
  /\bweather\b.*?\b(?:in|for|at) ([^?.!,]+)/i.exec(text)?.[1]?.trim() || undefined;

const toolFollowUp = (toolName: string | undefined): string => {
  switch (toolName) {
    case "get_weather":
      return "Here is the current weather.";
    case "generate_haiku":
      return "Here is your haiku.";
    case "generate_task_steps":
      return "Done. I followed the steps you selected.";
    default:
      return "Done.";
  }
};

const MARS_PLAN = [
  { description: "Start The Planning", status: "enabled" },
  { description: "Design spacecraft", status: "enabled" },
  { description: "Launch mission", status: "enabled" },
];

const agentJson = (id: string): Json => ({
  id,
  type: "agent",
  name: `ag-ui-dojo-${featureOf(id)}`,
  version: 1,
  model: { id: "claude-sonnet-5" },
  system: "",
  tools: [],
  mcp_servers: [],
  skills: [],
  metadata: {},
  created_at: now(),
  updated_at: now(),
});

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && typeof (block as Json).text === "string" ? (block as Json).text : ""))
    .join("");
};

const readJson = async (req: IncomingMessage): Promise<Json> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === "object" ? (parsed as Json) : {};
};

const sendJson = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
};

/** Mount the fake on an aimock server at the Managed Agents prefixes. */
export function registerManagedAgentsFake(mockServer: MountTarget): void {
  const fake = new ManagedAgentsFake();
  for (const prefix of ["/v1/sessions", "/v1/agents"]) {
    mockServer.mount(prefix, fake.forPrefix(prefix));
  }
}
