/**
 * Seed building for one thread with slow multimodal URL fetches must not
 * serialize cold-cache inits for OTHER threads behind the global
 * _threadInitLock.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { StrandsAgent } from "../agent";
import { minimalRunInput, scriptedAgent } from "./helpers";

// Each cold-init needs a fresh stub (first run on the thread returns quickly).
const fastStub = (): import("@strands-agents/sdk").Agent => scriptedAgent();

describe("seed build is outside _threadInitLock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("concurrent cold-inits on different threads don't serialise on a slow seed", async () => {
    // Spy on global fetch; make all fetches slow (200ms) so the seed helper's
    // URL resolution for thread A blocks only A, not B.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      await new Promise((r) => setTimeout(r, 200));
      // Return an empty PNG body so the content converter drops it harmlessly.
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, {
        status: 200,
      }) as Response;
    }) as typeof fetch;

    const agent = new StrandsAgent({ agent: fastStub(), name: "s" });

    const inputA = minimalRunInput({
      threadId: "a",
      messages: [
        {
          id: "u-a1",
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                value: "https://example.invalid/slow.png",
              },
            },
          ],
        } as never,
        { id: "u-a2", role: "user", content: "hi" } as never,
      ],
    });
    const inputB = minimalRunInput({ threadId: "b" });

    const t0 = Date.now();
    // Launch A first (it will start fetching the slow URL for its seed).
    const a = agent.run(inputA);
    const aFirst = a.next();
    // Give A a tick to start but NOT enough time to finish the fetch.
    await new Promise((r) => setTimeout(r, 30));
    // Now B starts. B has no seed to fetch, should complete promptly even
    // while A is still blocked.
    const bStart = Date.now();
    const b = agent.run(inputB);
    const bFirst = await b.next();
    const bDur = Date.now() - bStart;
    expect(bFirst.done).toBe(false); // got an event
    // B's first event arrived well under A's 200ms seed-fetch delay →
    // confirms B is not serialised behind A's lock.
    expect(bDur).toBeLessThan(150);
    // Now finish A (drain both).
    await aFirst;
    for await (const _ of a) {
      void _;
    }
    for await (const _ of b) {
      void _;
    }
    const total = Date.now() - t0;
    expect(total).toBeGreaterThan(150); // A still paid its fetch cost
    globalThis.fetch = origFetch;
  });
});
