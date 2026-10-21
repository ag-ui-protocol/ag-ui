import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerStarterAgent } from "../index";

function mockFetch(response: Partial<Response>) {
  globalThis.fetch = vi.fn().mockResolvedValue(response);
}

describe("ServerStarterAgent.getCapabilities", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("fetches <url>/capabilities with the agent headers", async () => {
    mockFetch({
      ok: true,
      json: () => Promise.resolve({ custom: { serverManagedHistory: true } }),
    });
    const agent = new ServerStarterAgent({
      url: "http://localhost:8000/server-history/",
      headers: { Authorization: "Bearer t" },
    });

    const capabilities = await agent.getCapabilities();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:8000/server-history/capabilities",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer t",
          Accept: "application/json",
        }),
      }),
    );
    expect(capabilities.custom?.serverManagedHistory).toBe(true);
  });

  it("preserves query parameters", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({}) });
    const agent = new ServerStarterAgent({
      url: "http://localhost:8000/?tenant=a",
    });

    await agent.getCapabilities();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:8000/capabilities?tenant=a",
      expect.any(Object),
    );
  });

  it("uses the custom fetch from the agent config", async () => {
    globalThis.fetch = vi.fn();
    const customFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    const agent = new ServerStarterAgent({
      url: "http://localhost:8000",
      fetch: customFetch,
    });

    await agent.getCapabilities();

    expect(customFetch).toHaveBeenCalledWith(
      "http://localhost:8000/capabilities",
      expect.any(Object),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("resolves relative agent URLs against the page location", async () => {
    vi.stubGlobal("location", { href: "https://app.example.com/chat/page" });
    try {
      mockFetch({ ok: true, json: () => Promise.resolve({}) });
      const agent = new ServerStarterAgent({ url: "/api/agent" });

      await agent.getCapabilities();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://app.example.com/api/agent/capabilities",
        expect.any(Object),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws on non-OK responses with the body", async () => {
    mockFetch({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    });
    const agent = new ServerStarterAgent({ url: "http://localhost:8000" });

    await expect(agent.getCapabilities()).rejects.toThrow(
      "HTTP 404: Not Found",
    );
  });

  it("throws on responses that are not valid capabilities", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ custom: "nope" }) });
    const agent = new ServerStarterAgent({ url: "http://localhost:8000" });

    await expect(agent.getCapabilities()).rejects.toThrow(
      "Invalid capabilities response",
    );
  });
});
