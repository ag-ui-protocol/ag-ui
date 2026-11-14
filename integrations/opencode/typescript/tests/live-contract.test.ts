import { it, expect } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { EventSchemas } from "@ag-ui/core/schemas";
import {
  OpenCodeBridge,
  createSdkTransport,
  FileSessionStore,
} from "../src/server";
import type { BaseEvent } from "@ag-ui/core";

/** Opt-in contract test uses a REAL OpenCode binary and a deterministic local model. */
it.skipIf(process.env.OPENCODE_LIVE_TEST !== "1")(
  "validates live server text/tools/permission/question/error/abort contracts without credentials",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "opencode-contract-"));
    const hanging = new Set<ServerResponse>();
    const provider = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      const lastUser = [...request.messages]
        .reverse()
        .find((m: any) => m.role === "user");
      const prompt = JSON.stringify(lastUser?.content);
      const afterTool = request.messages.at(-1)?.role === "tool";
      if (prompt.includes("[error]")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "fixture model authentication failed",
              type: "authentication_error",
            },
          }),
        );
        return;
      }
      if (!request.stream) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: "fixture",
            object: "chat.completion",
            created: 1,
            model: "mock",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Fixture" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (prompt.includes("[abort]")) {
        chunk({ role: "assistant", content: "Waiting" });
        hanging.add(res);
        res.on("close", () => hanging.delete(res));
        return;
      }
      const tool =
        !afterTool &&
        (prompt.includes("[permission]") || prompt.includes("[question]"));
      if (tool) {
        const question = prompt.includes("[question]");
        const name = question ? "question" : "bash";
        const args = question
          ? {
              questions: [
                {
                  question: "Which color?",
                  header: "Color",
                  options: [{ label: "Blue", description: "Blue" }],
                },
              ],
            }
          : { command: "printf fixture", description: "Print fixture" };
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${randomUUID()}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: "Hello " });
        chunk({ content: "from live OpenCode." });
        chunk({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const config = {
      model: "fixture/mock",
      small_model: "fixture/mock",
      enabled_providers: ["fixture"],
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture",
          options: {
            baseURL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
            apiKey: "fixture-only",
          },
          models: {
            mock: { name: "Mock", limit: { context: 100000, output: 1000 } },
          },
        },
      },
      permission: { bash: "ask" },
      autoupdate: false,
    };
    await writeFile(join(folder, "opencode.json"), JSON.stringify(config));
    const child = spawn(
      process.env.OPENCODE_BIN ?? "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: folder,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_SERVER_PASSWORD: "contract-only",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let processError: Error | undefined;
    child.on("error", (error) => {
      processError = error;
    });
    child.stdout.resume();
    child.stderr.resume();
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      Authorization: `Basic ${Buffer.from("opencode:contract-only").toString("base64")}`,
    };
    const traces: unknown[] = [];
    const ownedSessions: string[] = [];
    try {
      const deadline = Date.now() + 45000;
      while (true) {
        if (processError) throw processError;
        try {
          if (
            (
              await fetch(`${baseUrl}/global/health`, {
                headers,
                signal: AbortSignal.timeout(2000),
              })
            ).ok
          )
            break;
        } catch {
          /* starting */
        }
        if (Date.now() > deadline) throw new Error("OpenCode did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
      console.log("Live OpenCode is healthy; checking OpenAPI");
      const doc = await (
        await fetch(`${baseUrl}/doc`, {
          headers,
          signal: AbortSignal.timeout(30000),
        })
      ).json();
      for (const path of [
        "/session/{sessionID}/prompt_async",
        "/permission/{requestID}/reply",
        "/question/{requestID}/reply",
      ])
        expect(doc.paths[path]).toBeDefined();
      const sdk = createSdkTransport({ baseUrl, directory: folder, headers });
      const transport = {
        ...sdk,
        async create(signal: AbortSignal) {
          const id = await sdk.create(signal);
          ownedSessions.push(id);
          return id;
        },
        async subscribe(signal: AbortSignal) {
          const stream = await sdk.subscribe(signal);
          return {
            async *[Symbol.asyncIterator]() {
              for await (const event of stream) {
                traces.push(event);
                yield event;
              }
            },
          };
        },
      };
      const store = new FileSessionStore(join(folder, "bridge"));
      const bridge = new OpenCodeBridge({
        transport,
        store,
        directory: folder,
        timeoutMs: 45000,
      });
      const run = async (
        content: string,
        threadId = randomUUID(),
        resume?: any,
        cancelOnText = false,
      ) => {
        console.log("Live contract case:", content, resume ? "resume" : "new");
        const events: BaseEvent[] = [];
        const controller = new AbortController();
        await bridge.run(
          {
            threadId,
            runId: randomUUID(),
            tools: [],
            context: [],
            messages: [{ id: "u", role: "user", content }],
            resume,
          },
          { owner: "contract", directory: folder, signal: controller.signal },
          (e) => {
            EventSchemas.parse(e);
            events.push(e);
            if (cancelOnText && e.type === "TEXT_MESSAGE_CONTENT")
              controller.abort();
          },
        );
        console.log("Live contract terminal:", events.at(-1));
        return { threadId, events };
      };
      const text = await run("[text] Say hello");
      expect(text.events.at(-1)?.outcome).toEqual({ type: "success" });
      for (const reply of ["once", "reject"] as const) {
        const permission = await run("[permission] Print fixture");
        const outcome = permission.events.at(-1)?.outcome as any;
        expect(outcome?.type).toBe("interrupt");
        const resumed = await run("ignored", permission.threadId, [
          {
            interruptId: outcome.interrupts[0].id,
            status: "resolved",
            payload: { reply },
          },
        ]);
        expect(resumed.events.at(-1)?.outcome).toEqual({
          type: reply === "reject" ? "cancelled" : "success",
        });
        expect(resumed.events.some((e) => e.type === "TOOL_CALL_RESULT")).toBe(
          true,
        );
      }
      const question = await run("[question] Ask which color");
      const outcome = question.events.at(-1)?.outcome as any;
      expect(outcome?.type).toBe("interrupt");
      const answer = await run("ignored", question.threadId, [
        {
          interruptId: outcome.interrupts[0].id,
          status: "resolved",
          payload: { answers: [["Blue"]] },
        },
      ]);
      expect(answer.events.at(-1)?.outcome).toEqual({ type: "success" });
      expect((await run("[error]")).events.at(-1)?.type).toBe("RUN_ERROR");
      expect(
        (await run("[abort]", undefined, undefined, true)).events.at(-1)
          ?.outcome,
      ).toEqual({ type: "cancelled" });
      if (process.env.OPENCODE_TRACE_OUTPUT)
        await writeFile(
          process.env.OPENCODE_TRACE_OUTPUT,
          JSON.stringify(traces, null, 2).replaceAll(
            folder,
            "/disposable-project",
          ),
        );
    } finally {
      // Delete only sessions created by this test, before removing the disposable project.
      await Promise.allSettled(
        ownedSessions.map((id) =>
          fetch(
            `${baseUrl}/session/${id}?directory=${encodeURIComponent(folder)}`,
            { method: "DELETE", headers, signal: AbortSignal.timeout(5000) },
          ),
        ),
      );
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }
      });
      for (const res of hanging) res.end();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    }
  },
  180000,
);
