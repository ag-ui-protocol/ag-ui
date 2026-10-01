// A scripted stand-in for the Claude Managed Agents API (the `beta.agents`,
// `beta.environments` and `beta.sessions` endpoints), mounted on aimock.
//
// aimock fakes model APIs (`/v1/messages` and friends) by matching a request to
// a canned response. Managed Agents is not a model API: it is a hosted agent
// runtime with server-side sessions, a long-lived SSE event stream per session,
// and events posted into it out of band. None of that fits aimock's fixture
// matching, so the three Claude Managed Agents Dojo lanes (Python, TypeScript,
// .NET) are served by this handler instead, through aimock's `mount()` hook.
//
// It implements just enough of the API for the Dojo examples:
//   - GET/POST /v1/environments, GET/POST /v1/agents, GET /v1/agents/{id}
//     (provisioning, and the tool list an override session merges with)
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
// whose ids are `agent_fake_<feature>`; provisioning against this fake mints
// ids of the same shape.

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/** The slice of aimock's `Mountable` this handler implements. */
export interface ManagedAgentsMount {
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
}

export const FAKE_AGENT_PREFIX = "agent_fake_";

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
const loadHaikus = (): HaikuFixture[] => {
  try {
    return (JSON.parse(readFileSync(HAIKU_FIXTURES_PATH, "utf-8")) as { fixtures: HaikuFixture[] })
      .fixtures;
  } catch {
    return [];
  }
};

/** The Dojo feature a managed agent id stands for. */
export const featureOf = (agentId: string): string =>
  agentId.startsWith(FAKE_AGENT_PREFIX) ? agentId.slice(FAKE_AGENT_PREFIX.length) : agentId;

/** `ag-ui-dojo-backend-tool-rendering` → `backend_tool_rendering`. */
const featureFromAgentName = (name: string): string =>
  name.replace(/^ag-ui-dojo-/, "").replace(/-/g, "_");

const now = () => new Date().toISOString();

export class ManagedAgentsFake implements ManagedAgentsMount {
  private readonly sessions = new Map<string, Session>();
  private readonly environments: Json[] = [];
  private readonly agents = new Map<string, Json>();
  private readonly haikus = loadHaikus();
  private counter = 0;

  /** `prefix` is the path this instance is mounted at, e.g. `/v1/sessions`. */
  forPrefix(prefix: string): ManagedAgentsMount {
    return {
      handleRequest: (req, res, subPath) =>
        this.route(req, res, `${prefix}${subPath === "/" ? "" : subPath}`),
    };
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    return this.route(req, res, pathname);
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
      if (resource === "environments") return await this.environmentsRoute(req, res, method, id);
      if (resource === "agents") return await this.agentsRoute(req, res, method, id);
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
        const stamped = events.map((event) => ({ ...event, id: this.nextId("sevt_"), processed_at: now() }));
        sendJson(res, 200, { data: stamped });
        // Answer after the send has returned, as the real session does: the
        // reply arrives on the stream, never in the send's response.
        setTimeout(() => this.react(session, events), 5);
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

  private async environmentsRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    id: string | undefined,
  ): Promise<boolean> {
    if (!id && method === "GET") return sendJson(res, 200, page(this.environments));
    if (!id && method === "POST") {
      const body = await readJson(req);
      const environment = { id: this.nextId("env_fake_"), type: "environment", name: body.name, created_at: now() };
      this.environments.push(environment);
      return sendJson(res, 200, environment);
    }
    const environment = this.environments.find((candidate) => candidate.id === id);
    return environment ? sendJson(res, 200, environment) : false;
  }

  private async agentsRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    id: string | undefined,
  ): Promise<boolean> {
    if (!id && method === "GET") return sendJson(res, 200, page([...this.agents.values()]));
    if (!id && method === "POST") {
      const body = await readJson(req);
      const name = typeof body.name === "string" ? body.name : "agent";
      const agent = agentJson(`${FAKE_AGENT_PREFIX}${featureFromAgentName(name)}`, name);
      this.agents.set(agent.id as string, agent);
      return sendJson(res, 200, agent);
    }
    if (id && method === "GET") {
      // Any id resolves, so a keyless run that loaded the checked-in ids file
      // (and never provisioned) still gets the agent's (empty) tool list.
      return sendJson(res, 200, this.agents.get(id) ?? agentJson(id, `ag-ui-dojo-${featureOf(id)}`));
    }
    return false;
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
      } else if (event.type === "user.interrupt") {
        session.awaiting.clear();
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
        const city = /weather (?:in|for) ([^?.!,]+)/i.exec(latest)?.[1]?.trim();
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
        if (/plan/i.test(latest)) return this.callTool(session, "generate_task_steps", { steps: planSteps(latest) });
        break;
      }
    }

    this.say(session, chatReply(session.userTexts, latest));
    this.idle(session, { type: "end_turn" });
  }
}

/** A deterministic chat reply that recalls what the user said earlier in the session. */
export const chatReply = (history: string[], latest: string): string => {
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
  if (/favorite fruit/i.test(latest) && /remind|what/i.test(latest)) {
    const fruit = recall(/my favorite fruit is ([A-Za-z]+)/i);
    return fruit ? `Your favorite fruit is ${fruit}.` : "You have not told me your favorite fruit yet.";
  }
  if (/^(hi|hello|hey)\b/i.test(latest.trim()) && latest.trim().length < 12) {
    return "Hello! How can I help you today?";
  }
  return `Hello! You said: ${latest}`;
};

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

const planSteps = (prompt: string): { description: string; status: "enabled" }[] => {
  if (/start the planning/i.test(prompt)) {
    return [
      { description: "Start The Planning", status: "enabled" },
      { description: "Design spacecraft", status: "enabled" },
      { description: "Launch mission", status: "enabled" },
    ];
  }
  return [
    { description: "Crack eggs into bowl", status: "enabled" },
    { description: "Preheat oven to 350F", status: "enabled" },
    { description: "Mix and bake for 25 min", status: "enabled" },
  ];
};

const agentJson = (id: string, name: string): Json => ({
  id,
  type: "agent",
  name,
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

const page = (data: Json[]): Json => ({ data, next_page: null, has_more: false, first_id: null, last_id: null });

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

/** Mount the fake on an aimock server at the three Managed Agents prefixes. */
export function registerManagedAgentsFake(mockServer: MountTarget): ManagedAgentsFake {
  const fake = new ManagedAgentsFake();
  for (const prefix of ["/v1/sessions", "/v1/agents", "/v1/environments"]) {
    mockServer.mount(prefix, fake.forPrefix(prefix));
  }
  return fake;
}
