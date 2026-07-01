import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpAgent } from "../agent/http";

/**
 * Regression test for #1891: HttpAgent threw "Illegal invocation" in browsers
 * when no custom `fetch` was supplied.
 *
 * A browser's native `fetch` is a checked-receiver method: it throws
 * "Illegal invocation" unless called with the global object as `this`. The old
 * code stored the bare global (`this.fetch = config.fetch ?? fetch`) and later
 * invoked it as `this.fetch(...)`, setting the receiver to the agent instance.
 *
 * We replicate the browser behaviour by installing a checked-receiver stub on
 * `globalThis.fetch`, then invoke the agent's default fetch the same way the
 * agent does internally.
 */
describe("HttpAgent default fetch binding (#1891)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not throw 'Illegal invocation' when the default fetch is invoked as a method", async () => {
    const response = new Response("ok");
    // Checked-receiver stub: behaves like the browser's native fetch, which
    // rejects any receiver that is not the global object.
    const browserLikeFetch = function (this: unknown, ..._args: unknown[]) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(response);
    };
    globalThis.fetch = browserLikeFetch as unknown as typeof fetch;

    const agent = new HttpAgent({ url: "https://example.com/api" });

    // Invoke exactly as the agent does internally: `this.fetch(...)`, i.e. with
    // the agent instance as the receiver. The binding must keep `fetch` happy.
    await expect(agent.fetch("https://example.com/api", {})).resolves.toBe(response);
  });

  it("delegates to the global fetch with the given url and init", async () => {
    const response = new Response("ok");
    const spy = vi.fn().mockResolvedValue(response);
    globalThis.fetch = spy as unknown as typeof fetch;

    const agent = new HttpAgent({ url: "https://example.com/api" });
    const init = { method: "POST" };
    await agent.fetch("https://example.com/api", init);

    expect(spy).toHaveBeenCalledWith("https://example.com/api", init);
  });

  it("still honours a custom fetch when supplied", async () => {
    const response = new Response("custom");
    const custom = vi.fn().mockResolvedValue(response);

    const agent = new HttpAgent({ url: "https://example.com/api", fetch: custom });
    await expect(agent.fetch("https://example.com/api", {})).resolves.toBe(response);
    expect(custom).toHaveBeenCalledOnce();
  });
});
