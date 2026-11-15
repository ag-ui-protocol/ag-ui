import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmnaraApi } from "../api";

const id = (prefix: string, c = "a") => `${prefix}_${c.repeat(26)}`;
const at = "2026-10-09T00:00:00Z";

/** An agent profile as Omnara lists it. */
function profile(c: string, name: string) {
  return {
    id: id("aprf", c),
    org_id: id("org"),
    project_id: id("proj"),
    name,
    current_config_id: id("acfg"),
    current_generation: 1,
    created_at: at,
    updated_at: at,
    current_config: {
      id: id("acfg"),
      org_id: id("org"),
      project_id: id("proj"),
      effective_definition_hash: "h",
      created_at: at,
      model: {
        provider_config: "p",
        name: "m",
        provider_model_slug: "s",
        configured_model_id: id("mdl"),
        current_revision_id: id("mrev"),
        api_format: "openai-chat-completions",
        api_variant: "default",
        context_window_tokens: 1000,
        max_output_tokens: null,
        default_cache_retention: "none",
        supports_tools: true,
        supports_reasoning: false,
        default_reasoning_effort: "none",
        supported_reasoning_efforts: [],
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
    },
  };
}

/** Omnara listing profiles newest first, at most `limit` of them. */
function serve(profiles: ReturnType<typeof profile>[]) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const body = { data: profiles.slice(0, limit), next_cursor: null };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const api = createOmnaraApi({
    apiKey: "key",
    orgId: id("org"),
    projectId: id("proj"),
  });
  const nameFilter = () => {
    const [input] = fetch.mock.calls.at(-1)!;
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.searchParams.get("name");
  };
  return { api, nameFilter };
}

/** Omnara listing two pages; like Omnara, an unknown cursor is rejected. */
function servePages(first: unknown[], second: unknown[]) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && cursor !== "page-2")
      return new Response(null, { status: 400 });
    const last = cursor === "page-2";
    const body = {
      data: last ? second : first,
      next_cursor: last ? null : "page-2",
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return createOmnaraApi({
    apiKey: "key",
    orgId: id("org"),
    projectId: id("proj"),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("profile lookup", () => {
  it("finds a profile by its exact name when another differs only in case", async () => {
    // Omnara matches the name filter case-insensitively, newest first.
    const { api } = serve([profile("b", "Support"), profile("c", "support")]);
    expect((await api.getProfile("support")).id).toBe(id("aprf", "c"));
    expect((await api.getProfile("Support")).id).toBe(id("aprf", "b"));
  });

  it("escapes the wildcards Omnara's name filter would otherwise match", async () => {
    const name = "beta*v2?x\\y";
    const { api, nameFilter } = serve([profile("b", name)]);
    expect((await api.getProfile(name)).id).toBe(id("aprf", "b"));
    expect(nameFilter()).toBe("beta\\*v2\\?x\\\\y");
  });
});

describe("subagents", () => {
  /** A subagent as Omnara lists it; `n` makes its id unique. */
  const child = (n: number, state: "idle" | "running") => ({
    id: `agt_${String(n)
      .padStart(26, "0")
      .replace(/\d/g, (d) => "abcdefghij"[Number(d)]!)}`,
    org_id: id("org"),
    project_id: id("proj"),
    parent_agent_id: id("agt", "p"),
    state: "active",
    name: "",
    created_at: at,
    updated_at: at,
    activity: { state, last_activity_at: at },
  });

  it("lists every page of an agent's subagents", async () => {
    // More than a page of idle ones, newest first; the running one is older.
    const first = Array.from({ length: 100 }, (_, n) => child(n, "idle"));
    const running = child(100, "running");
    const api = servePages(first, [running]);
    const children = await api.listChildren(id("agt", "p"));
    expect(children).toHaveLength(101);
    expect(children.at(-1)).toMatchObject({
      id: running.id,
      activity: { state: "running" },
    });
  });
});

describe("backlog", () => {
  it("lists every page of an agent's backlog", async () => {
    // This request's message is queued behind more than a page of others.
    const input = (key: string) => ({
      id: id("ain"),
      agent_id: id("agt", "p"),
      state: "received",
      delivery_mode: "queued",
      input_kind: "content",
      queued_at: at,
      input_idempotency_key: key,
    });
    const api = servePages(
      Array.from({ length: 100 }, (_, n) => input(`other-${n}`)),
      [input("agui:u-1")],
    );
    const backlog = await api.listBacklog(id("agt", "p"));
    expect(backlog).toHaveLength(101);
    expect(backlog.at(-1)?.input_idempotency_key).toBe("agui:u-1");
  });
});
