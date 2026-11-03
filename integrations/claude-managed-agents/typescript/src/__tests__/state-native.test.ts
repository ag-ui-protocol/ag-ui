import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { STATE_HEADER, STATE_TOOL, stateToolDefinition } from "../state";
const require = createRequire(import.meta.url);
it("persists native SDK state writes and recovers them in a cold subprocess", async () => {
  const history: any[] = [];
  let stream: ServerResponse | undefined;
  let count = 0;
  let latest: any;
  let catalog: any[] = [];
  const send = (event: any) => {
    history.push(event);
    stream?.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const stamp = (e: any) => ({
    ...e,
    id: `event_${++count}`,
    session_id: "sesn_probe",
    session_thread_id: "primary_probe",
    processed_at: `2026-10-21T15:00:${String(count).padStart(2, "0")}.000Z`,
  });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("/events/stream")) {
      stream = res;
      res.setHeader("content-type", "text/event-stream");
      res.flushHeaders();
      return;
    }
    if (req.method === "GET" && req.url?.includes("/agents/")) {
      res.end(JSON.stringify({ tools: [] }));
      return;
    }
    if (req.method === "GET" && req.url?.includes("/threads")) {
      res.end(
        JSON.stringify({
          data: [
            {
              id: "primary_probe",
              session_id: "sesn_probe",
              parent_thread_id: null,
            },
          ],
          has_more: false,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url?.includes("/events")) {
      res.end(JSON.stringify({ data: history, has_more: false }));
      return;
    }
    if (req.method === "GET") {
      res.end(
        JSON.stringify({
          id: "sesn_probe",
          status: "idle",
          agent: { tools: catalog },
        }),
      );
      return;
    }
    if (data.events) {
      const systemIndices = data.events.flatMap((e: any, i: number) =>
        e.type === "system.message" ? [i] : [],
      );
      if (
        systemIndices.length > 1 ||
        (systemIndices.length &&
          (systemIndices[0] !== data.events.length - 1 ||
            ![
              "user.message",
              "user.custom_tool_result",
              "user.tool_result",
            ].includes(data.events[systemIndices[0] - 1]?.type)))
      ) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "At most one final companion system message",
            },
          }),
        );
        return;
      }
      const saved = data.events.map(stamp);
      history.push(...saved);
      res.end(JSON.stringify({ data: saved }));
      for (const e of saved) {
        if (
          e.type === "system.message" &&
          e.content.some((b: any) => b.text?.startsWith(STATE_HEADER))
        )
          latest = JSON.parse(
            e.content
              .find((b: any) => b.text?.startsWith(STATE_HEADER))
              .text.slice(STATE_HEADER.length),
          );
        if (e.type === "user.custom_tool_result") {
          latest = JSON.parse(e.content[0].text.slice(STATE_HEADER.length));
          send(
            stamp({
              type: "session.status_idle",
              stop_reason: { type: "end_turn" },
            }),
          );
          stream?.end();
        }
      }
      if (saved.some((e: any) => e.type === "user.message")) {
        if (!latest) {
          send(
            stamp({
              type: "session.status_idle",
              stop_reason: { type: "end_turn" },
            }),
          );
          stream?.end();
          return;
        }
        // Deterministic local provider derives its tool request exclusively from native state.
        send(
          stamp({
            type: "agent.custom_tool_use",
            name: STATE_TOOL,
            input: {
              operation: "merge_patch",
              expectedRevision: latest.revision,
              patch: {
                obsolete: null,
                board: {
                  readValue: latest.state.secret,
                  count: (latest.state.board?.count ?? 0) + 1,
                },
              },
            },
          }),
        );
      }
      return;
    }
    if (data.agent?.tools) catalog = data.agent.tools;
    res.end(JSON.stringify({ id: "sesn_probe" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as import("node:net").AddressInfo;
  const run = (imported: boolean) =>
    new Promise<any[]>((ok, fail) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          resolve("scripts/state-native-probe.mjs"),
          JSON.stringify({
            baseURL: `http://127.0.0.1:${addr.port}`,
            imported,
          }),
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", fail);
      child.on("close", (code) => {
        if (code !== 0) return fail(new Error(err));
        try {
          ok(JSON.parse(out));
        } catch (e) {
          fail(new Error(out + err));
        }
      });
    });
  try {
    const first = await run(false);
    expect(first.at(-1)?.type).toBe("RUN_FINISHED");
    expect(latest?.state).toEqual({
      secret: "unique-state-only-692",
      board: { readValue: "unique-state-only-692", count: 1 },
    });
    const second = await run(true);
    expect(second.at(-1)?.type).toBe("RUN_FINISHED");
    expect(latest.revision).toBe(3);
    expect(latest.state.board.count).toBe(2);
    expect(
      second.filter((e) => e.type === "STATE_SNAPSHOT").at(-1)?.snapshot,
    ).toEqual(latest.state);
    expect(catalog).toEqual([stateToolDefinition()]);
    expect(
      history
        .filter((e) => e.type === "user.message")
        .every((e) => !JSON.stringify(e).includes("unique-state-only-692")),
    ).toBe(true);
    if (process.env.WRITE_STATE_FIXTURE === "1")
      writeFileSync(
        resolve("../contracts/typescript-state-events.json"),
        JSON.stringify(
          {
            source:
              "deterministic localhost provider via installed Anthropic SDK subprocesses",
            sessionId: "sesn_probe",
            primaryThreadId: "primary_probe",
            events: history,
          },
          null,
          2,
        ) + "\n",
      );
  } finally {
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 20000);
