import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import type { AddressInfo } from "net";

import { createStrandsApp, type CreateStrandsAppOptions } from "../server";
import { StrandsAgent } from "../agent";

class FixedAgent extends StrandsAgent {
  private readonly _events: BaseEvent[];
  constructor(events: BaseEvent[]) {
    super({
      agent: {
        model: {},
        tools: [],
        toolRegistry: {
          list: () => [],
          add() {},
          get: () => undefined,
          remove() {},
        },
        sessionManager: undefined,
      } as unknown as import("@strands-agents/sdk").Agent,
      name: "fixed",
    });
    this._events = events;
  }
  async *run(_input: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
    for (const e of this._events) yield e;
  }
}

async function startApp(options?: CreateStrandsAppOptions): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const app = await createStrandsApp(
    new FixedAgent([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ]),
    options,
  );
  const server = await new Promise<import("http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Issue a CORS preflight (OPTIONS) carrying an Origin and read back the ACA-* headers. */
async function preflight(
  port: number,
  origin: string,
): Promise<{ allowOrigin: string | null; allowCredentials: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
    },
  });
  return {
    allowOrigin: res.headers.get("access-control-allow-origin"),
    allowCredentials: res.headers.get("access-control-allow-credentials"),
  };
}

describe("createStrandsApp CORS", () => {
  it("defaults to a literal `*` origin (matches the Python adapter), not a reflected one", async () => {
    const { port, close } = await startApp();
    try {
      const { allowOrigin, allowCredentials } = await preflight(
        port,
        "https://evil.example.com",
      );
      // Literal wildcard, NOT the reflected request Origin. `origin: true`
      // (the previous default) would have echoed "https://evil.example.com".
      expect(allowOrigin).toBe("*");
      expect(allowOrigin).not.toBe("https://evil.example.com");
      expect(allowCredentials).toBe("true");
    } finally {
      await close();
    }
  });

  it("honours an explicit single-origin override", async () => {
    const allowed = "https://app.example.com";
    const { port, close } = await startApp({ corsOrigin: allowed });
    try {
      const { allowOrigin, allowCredentials } = await preflight(port, allowed);
      expect(allowOrigin).toBe(allowed);
      expect(allowCredentials).toBe("true");
    } finally {
      await close();
    }
  });
});
