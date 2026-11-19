/** Credential-free HTTP fixture exercising the actual pinned SDK and bridge. Never used implicitly. */
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

export async function startFixture() {
  const subscribers = new Set<ServerResponse>();
  const sessions = new Map<
    string,
    Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>
  >();
  const pending = new Map<
    string,
    {
      kind: string;
      request: Record<string, unknown>;
      complete: (answer: string) => void;
    }
  >();
  const emit = (type: string, properties: Record<string, unknown>) => {
    const event = { id: randomUUID(), type, properties };
    for (const stream of subscribers)
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: randomUUID(), type: "server.connected", properties: {} })}\n\n`,
      );
      subscribers.add(res);
      res.on("close", () => subscribers.delete(res));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    if (path === "/session" && req.method === "POST") {
      const id = `ses_${randomUUID()}`;
      sessions.set(id, []);
      send({ id });
      return;
    }
    if (path === "/permission" || path === "/question") {
      send(
        [...pending.values()]
          .filter((p) => `/${p.kind}` === path)
          .map((p) => p.request),
      );
      return;
    }
    const reply = path.match(
      /^\/(permission|question)\/([^/]+)\/(reply|reject)$/,
    );
    if (reply) {
      const item = pending.get(reply[2]);
      if (!item) {
        send({}, 404);
        return;
      }
      pending.delete(reply[2]);
      send(true);
      setTimeout(
        () =>
          item.complete(
            body.reply ??
              (reply[3] === "reject" ? "reject" : JSON.stringify(body.answers)),
          ),
        10,
      );
      return;
    }
    const match = path.match(
      /^\/session\/([^/]+)\/(message|prompt_async|abort)$/,
    );
    if (!match || !sessions.has(match[1])) {
      send({}, 404);
      return;
    }
    const sessionID = match[1];
    const messages = sessions.get(sessionID)!;
    if (match[2] === "message") {
      send(messages);
      return;
    }
    if (match[2] === "abort") {
      for (const [id, item] of pending)
        if (item.request.sessionID === sessionID) pending.delete(id);
      send(true);
      emit("session.error", {
        sessionID,
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      });
      return;
    }
    res.writeHead(204);
    res.end();
    const text = body.parts[0].text as string;
    const id = `msg_${randomUUID()}`;
    const info = {
      id,
      sessionID,
      role: "assistant",
      parentID: body.messageID,
      time: { created: Date.now() },
      modelID: "fixture",
      providerID: "fixture",
      mode: "build",
      agent: "build",
      path: { cwd: "/fixture", root: "/fixture" },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };
    const assistant = {
      info: info as Record<string, unknown>,
      parts: [] as Record<string, unknown>[],
    };
    messages.push(
      {
        info: { id: body.messageID, sessionID, role: "user" },
        parts: body.parts,
      },
      assistant,
    );
    setTimeout(() => {
      emit("message.updated", { sessionID, info });
      const complete = (answer?: string) => {
        const result = answer
          ? `Request response: ${answer}. Done.`
          : /capital|france/i.test(text)
            ? "The capital of France is Paris."
            : /remember|previous/i.test(text)
              ? messages
                  .slice(0, -2)
                  .some(
                    (m) =>
                      m.info.role === "user" &&
                      m.parts.some((p) => /france/i.test(String(p.text))),
                  )
                ? "We discussed Paris, the capital of France."
                : "No previous conversation."
              : "Hello from OpenCode! How can I help?";
        const tool = {
          id: `prt_${randomUUID()}`,
          sessionID,
          messageID: id,
          type: "tool",
          callID: `call_${randomUUID()}`,
          tool: "fixture_lookup",
          state: {
            status: "completed",
            input: { query: text },
            output: "Fixture lookup complete",
            title: "Lookup",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        };
        assistant.parts.push(tool);
        emit("message.part.updated", {
          sessionID,
          part: tool,
          time: Date.now(),
        });
        const part = {
          id: `prt_${randomUUID()}`,
          sessionID,
          messageID: id,
          type: "text",
          text: "",
        };
        assistant.parts.push(part);
        emit("message.part.updated", {
          sessionID,
          part: { ...part },
          time: Date.now(),
        });
        for (const delta of result.match(/.{1,9}/g)!) {
          part.text += delta;
          emit("message.part.delta", {
            sessionID,
            messageID: id,
            partID: part.id,
            field: "text",
            delta,
          });
        }
        emit("message.part.updated", { sessionID, part, time: Date.now() });
        assistant.info = {
          ...info,
          time: { ...info.time, completed: Date.now() },
          finish: "stop",
        };
        emit("message.updated", { sessionID, info: assistant.info });
      };
      if (/\[error\]/.test(text)) {
        emit("session.error", {
          sessionID,
          error: {
            name: "UnknownError",
            data: { message: "secret provider detail" },
          },
        });
        return;
      }
      if (/\[hang\]/.test(text)) return;
      const kind = /\[permission\]/.test(text)
        ? "permission"
        : /\[question\]/.test(text)
          ? "question"
          : undefined;
      if (kind) {
        const requestID = randomUUID();
        const request =
          kind === "permission"
            ? {
                id: requestID,
                sessionID,
                permission: "read",
                patterns: ["README.md"],
                always: [],
                metadata: {},
                tool: { messageID: id, callID: "approval" },
              }
            : {
                id: requestID,
                sessionID,
                questions: [
                  {
                    question: "Which color?",
                    header: "Color",
                    options: [{ label: "Blue", description: "Blue" }],
                    custom: false,
                  },
                ],
                tool: { messageID: id, callID: "question" },
              };
        pending.set(requestID, { kind, request, complete });
        emit(`${kind}.asked`, request);
      } else complete();
    }, 10);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sessions,
    close: async () => {
      for (const res of subscribers) res.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
