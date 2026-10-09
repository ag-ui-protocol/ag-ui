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
