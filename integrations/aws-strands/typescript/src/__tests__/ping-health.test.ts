import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import type { AddressInfo } from "net";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { addPing, addStrandsExpressEndpoint } from "../endpoint";
import { createStrandsApp } from "../server";
import type { StrandsAgent } from "../agent";
import { minimalRunInput } from "./helpers";

function controlledAgent() {
  const releases = new Map<string, () => void>();
  const agent = {
    config: {},
    async *run(input: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.set(input.runId, release);
      yield {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      };
      await gate;
      if (input.runId === "error") throw new Error("Agent failed");
      yield {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      };
    },
  } as unknown as StrandsAgent;
  return {
    agent,
    release: (id: string) => releases.get(id)!(),
    releaseAll: () => releases.forEach((release) => release()),
  };
}

async function listen(app: Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function startRun(url: string, id: string, path = "/invocations") {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...minimalRunInput(), runId: id, threadId: id }),
  });
  const reader = response.body!.getReader();
  await reader.read();
  return reader;
}

async function consume(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (!(await reader.read()).done) {
    /* drain the SSE stream */
  }
}

const ping = async (url: string, path = "/ping") =>
  (await fetch(`${url}${path}`)).json();
afterEach(() => vi.restoreAllMocks());

describe("AgentCore ping health", () => {
  it("returns Healthy with an idle timestamp that does not advance on polling", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const app = express();
    addPing(app, "/ping");
    const server = await listen(app);
    try {
      expect(await ping(server.url)).toEqual({
        status: "Healthy",
        time_of_last_update: 100,
      });
      clock.mockReturnValue(200_000);
      expect(await ping(server.url)).toEqual({
        status: "Healthy",
        time_of_last_update: 100,
      });
    } finally {
      await server.close();
    }
  });

  it.each(["normal", "error"])(
    "returns to Healthy after %s completion through createStrandsApp",
    async (id) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
      const controlled = controlledAgent();
      const app = await createStrandsApp(controlled.agent, {
        path: "/invocations",
        pingPath: "/health",
        corsEnabled: false,
      });
      const server = await listen(app);
      try {
        clock.mockReturnValue(200_000);
        const reader = await startRun(server.url, id);
        expect(await ping(server.url, "/health")).toEqual({
          status: "HealthyBusy",
          time_of_last_update: 200,
        });
        clock.mockReturnValue(300_000);
        expect(await ping(server.url, "/health")).toEqual({
          status: "HealthyBusy",
          time_of_last_update: 200,
        });
        controlled.release(id);
        await consume(reader);
        expect(await ping(server.url, "/health")).toEqual({
          status: "Healthy",
          time_of_last_update: 300,
        });
      } finally {
        controlled.releaseAll();
        await server.close();
      }
    },
  );

  it("shares state across routes, keeps concurrent runs busy, and isolates Express apps", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const controlled = controlledAgent();
    const app = express();
    app.use(express.json());
    // Register ping before the agent routes to cover either installation order.
    addPing(app, "/ping");
    addStrandsExpressEndpoint(app, controlled.agent, { path: "/one" });
    addStrandsExpressEndpoint(app, controlled.agent, { path: "/two" });
    const server = await listen(app);
    const idleApp = express();
    addPing(idleApp, "/ping");
    const idleServer = await listen(idleApp);
    try {
      clock.mockReturnValue(200_000);
      const first = await startRun(server.url, "first", "/one");
      clock.mockReturnValue(300_000);
      const second = await startRun(server.url, "second", "/two");
      expect(await ping(server.url)).toEqual({
        status: "HealthyBusy",
        time_of_last_update: 200,
      });
      expect(await ping(idleServer.url)).toEqual({
        status: "Healthy",
        time_of_last_update: 100,
      });
      controlled.release("first");
      await consume(first);
      expect(await ping(server.url)).toEqual({
        status: "HealthyBusy",
        time_of_last_update: 200,
      });
      clock.mockReturnValue(400_000);
      controlled.release("second");
      await consume(second);
      expect(await ping(server.url)).toEqual({
        status: "Healthy",
        time_of_last_update: 400,
      });
    } finally {
      controlled.releaseAll();
      await server.close();
      await idleServer.close();
    }
  });

  it("releases an aborted response without waiting for a blocked generator", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const controlled = controlledAgent();
    const app = express();
    app.use(express.json());
    addStrandsExpressEndpoint(app, controlled.agent, { path: "/invocations" });
    addPing(app, "/ping");
    const server = await listen(app);
    try {
      const reader = await startRun(server.url, "aborted");
      expect((await ping(server.url)).status).toBe("HealthyBusy");
      clock.mockReturnValue(200_000);
      await reader.cancel();
      await expect
        .poll(() => ping(server.url))
        .toEqual({ status: "Healthy", time_of_last_update: 200 });
      // A late generator cleanup must not release this run a second time.
      const next = await startRun(server.url, "next");
      controlled.release("aborted");
      expect((await ping(server.url)).status).toBe("HealthyBusy");
      controlled.release("next");
      await consume(next);
      expect((await ping(server.url)).status).toBe("Healthy");
    } finally {
      controlled.releaseAll();
      await server.close();
    }
  });

  it("does not mark rejected or invalid requests busy", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const controlled = controlledAgent();
    const app = express();
    app.use(express.json());
    addStrandsExpressEndpoint(app, controlled.agent, { path: "/invocations" });
    addStrandsExpressEndpoint(app, controlled.agent, {
      path: "/private",
      auth: (_req, res) => res.sendStatus(401),
    });
    addPing(app, "/ping");
    const server = await listen(app);
    try {
      clock.mockReturnValue(200_000);
      expect(
        (
          await fetch(`${server.url}/invocations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(400);
      expect(
        (await fetch(`${server.url}/private`, { method: "POST" })).status,
      ).toBe(401);
      expect(await ping(server.url)).toEqual({
        status: "Healthy",
        time_of_last_update: 100,
      });
    } finally {
      await server.close();
    }
  });
});
