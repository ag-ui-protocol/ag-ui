import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { EventType, type Event, type RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
import { createTranslator, toAguiMessages } from "@ag-ui/pi";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createClientTools } from "./client-tools.ts";
import { conversation } from "./conversation.ts";

interface ExampleOptions {
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  customTools?: ToolDefinition[];
}

async function readInput(request: IncomingMessage): Promise<RunAgentInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request exceeds 1 MiB");
    chunks.push(chunk);
  }
  return RunAgentInputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export function createExampleServer(options: ExampleOptions) {
  async function run(request: IncomingMessage, response: ServerResponse) {
    if (request.url !== "/agentic_chat") {
      response.writeHead(404).end();
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      const url = URL.canParse(origin) ? new URL(origin) : undefined;
      if (
        !url ||
        !["http:", "https:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Origin", origin);
    }
    if (request.method === "OPTIONS") {
      response
        .writeHead(204, {
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept",
        })
        .end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    let input: RunAgentInput;
    let turn: ReturnType<typeof conversation>;
    let clientTools: ReturnType<typeof createClientTools>;
    try {
      input = await readInput(request);
      turn = conversation(input, options.model);
      clientTools = createClientTools(
        input.tools,
        options.customTools?.map((tool) => tool.name),
      );
    } catch {
      response
        .writeHead(400)
        .end("Expected a RunAgentInput with text history and matching tool results");
      return;
    }

    const messages: RunAgentInput["messages"] = input.messages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "tool",
    );
    let assistantId = "";
    let sequence = 0;
    const translator = createTranslator({
      threadId: input.threadId,
      runId: input.runId,
      completion: "session",
      messageId(message) {
        if (message.role === "toolResult") return `${input.runId}:result:${message.toolCallId}`;
        assistantId = `${input.runId}:assistant:${++sequence}`;
        return assistantId;
      },
      getMessages: () => messages,
    });
    const encoder = new EventEncoder();
    const write = (events: Event[]) => {
      for (const event of events) {
        if (event.type === EventType.RUN_FINISHED && clientTools.pending.size) {
          event.outcome = { type: "success", pendingToolCallIds: [...clientTools.pending] };
        }
        if (!response.destroyed) response.write(encoder.encode(event));
      }
    };
    response.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-cache",
    });
    write(translator.start());
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const cwd = process.cwd();
    // A fresh loader without discovery keeps local extensions and project instructions out of HTTP runs.
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager });
    try {
      const customTools = [...(options.customTools ?? []), ...clientTools.tools];
      const { session } = await createAgentSession({
        ...options,
        customTools,
        sessionManager: turn.sessionManager,
        resourceLoader,
        settingsManager,
        tools: customTools.map((tool) => tool.name),
        thinkingLevel: "off",
      });
      const abort = () => {
        void session.abort();
      };
      clientTools.bind(session);
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_start" && response.destroyed) abort();
        if (event.type === "message_end") {
          const { message } = event;
          if (message.role === "toolResult" && clientTools.pending.has(message.toolCallId)) return;
          if (message.role === "assistant" || message.role === "toolResult") {
            const id =
              message.role === "assistant"
                ? assistantId
                : `${input.runId}:result:${message.toolCallId}`;
            messages.push(...toAguiMessages([{ id, message }]));
          }
        }
        write(translator.translate(event));
      });
      response.once("close", abort);
      try {
        if (!response.destroyed) {
          if (turn.prompt !== undefined) {
            await session.prompt(turn.prompt, { expandPromptTemplates: false });
          } else {
            // Start the coding-session lifecycle without adding a second user prompt to the model history.
            const convert = session.agent.convertToLlm;
            session.agent.convertToLlm = (history) =>
              convert(
                history.filter(
                  (message) =>
                    message.role !== "custom" || message.customType !== "agui-tool-continuation",
                ),
              );
            await session.sendCustomMessage(
              {
                customType: "agui-tool-continuation",
                content: "",
                display: false,
                details: {},
              },
              { triggerTurn: true },
            );
          }
          await session.waitForIdle();
        }
      } finally {
        response.off("close", abort);
        unsubscribe();
        session.dispose();
      }
    } catch {
      write(translator.error("The Pi session failed"));
    } finally {
      response.end();
    }
  }
  return createServer((request, response) => {
    void run(request, response).catch(() => response.destroy());
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const id = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("dojo", {
    api: "openai-completions",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: "$OPENAI_API_KEY",
    models: [
      {
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const model = modelRuntime.getModel("dojo", id);
  if (!model) throw new Error("Could not register the configured model");
  createExampleServer({ modelRuntime, model }).listen(
    Number(process.env.PORT ?? 8032),
    process.env.HOST ?? "0.0.0.0",
  );
}
