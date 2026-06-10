/**
 * Tests for IAM token management: caching, refresh, dedup, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WatsonxAgent } from "../index";

function makeAgent(
  overrides: Partial<{
    apiKey: string;
    bearerToken: string;
  }> = {},
) {
  return new WatsonxAgent({
    region: "us-south",
    instanceId: "inst-1",
    agentId: "agent-1",
    bearerToken: "default-token",
    ...overrides,
  });
}

describe("Token management", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns cached token when it has not expired", async () => {
    const agent = makeAgent({ bearerToken: "cached-tok" });
    const token = await (agent as any).getToken();
    expect(token).toBe("cached-tok");
  });

  it("throws when token expired and no apiKey is available", async () => {
    const agent = makeAgent({ bearerToken: "old-tok" });
    (agent as any).tokenExpiresAt = 0; // force expiry

    await expect((agent as any).getToken()).rejects.toThrow(
      "bearer token expired and no apiKey provided",
    );
  });

  it("refreshes token via IAM when expired and apiKey is present", async () => {
    const agent = makeAgent({
      apiKey: "my-key",
      bearerToken: "old-tok",
    });
    (agent as any).tokenExpiresAt = 0; // force expiry

    const futureExpiration = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "fresh-token",
        expiration: futureExpiration,
      }),
    });

    const token = await (agent as any).getToken();
    expect(token).toBe("fresh-token");
    expect((agent as any).cachedToken).toBe("fresh-token");

    // Verify IAM endpoint was called
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, opts] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://iam.cloud.ibm.com/identity/token");
    expect(opts.method).toBe("POST");
    expect(opts.body).toContain("apikey=my-key");
  });

  it("rejects when IAM response is missing access_token", async () => {
    const agent = makeAgent({ apiKey: "key" });
    (agent as any).tokenExpiresAt = 0;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ expiration: 9999999999 }),
    });

    await expect((agent as any).getToken()).rejects.toThrow(
      "missing access_token",
    );
  });

  it("rejects when IAM response is missing expiration", async () => {
    const agent = makeAgent({ apiKey: "key" });
    (agent as any).tokenExpiresAt = 0;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "tok" }),
    });

    await expect((agent as any).getToken()).rejects.toThrow(
      "missing expiration",
    );
  });

  it("rejects when IAM returns a non-OK HTTP status", async () => {
    const agent = makeAgent({ apiKey: "key" });
    (agent as any).tokenExpiresAt = 0;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    await expect((agent as any).getToken()).rejects.toThrow(
      "IAM token exchange failed: HTTP 401",
    );
  });

  it("deduplicates concurrent token refresh calls", async () => {
    const agent = makeAgent({ apiKey: "key" });
    (agent as any).tokenExpiresAt = 0;

    let resolveIAM: (value: any) => void;
    const iamPromise = new Promise((resolve) => {
      resolveIAM = resolve;
    });

    globalThis.fetch = vi.fn().mockReturnValue(iamPromise);

    // Fire two concurrent getToken calls
    const p1 = (agent as any).getToken();
    const p2 = (agent as any).getToken();

    // Only one fetch should have been initiated
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    // Resolve the single IAM call
    resolveIAM!({
      ok: true,
      json: async () => ({
        access_token: "deduped-token",
        expiration: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe("deduped-token");
    expect(t2).toBe("deduped-token");
    // Confirm fetch was only called once despite two getToken() calls
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("clears the refresh promise after completion so next call refreshes again", async () => {
    const agent = makeAgent({ apiKey: "key" });
    (agent as any).tokenExpiresAt = 0;

    const futureExpiration = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "token-1",
        expiration: futureExpiration,
      }),
    });

    await (agent as any).getToken();
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    // Force expiry again
    (agent as any).tokenExpiresAt = 0;
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "token-2",
        expiration: futureExpiration,
      }),
    });

    const token2 = await (agent as any).getToken();
    expect(token2).toBe("token-2");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
