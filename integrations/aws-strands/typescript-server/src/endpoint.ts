import { IncomingMessage, ServerResponse, createServer } from "http";
import { EventEncoder } from "./encoder";
import { StrandsAgent } from "./agent";
import { EventType, RunAgentInput, RunErrorEvent } from "./types";

type HttpRequest = IncomingMessage & { body?: unknown };
type HttpResponse = ServerResponse & {
  flushHeaders?: () => void;
};

async function readBody(req: HttpRequest): Promise<unknown> {
  if (req.body !== undefined) return req.body;

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function createStrandsHandler(agent: StrandsAgent) {
  return async function handle(req: HttpRequest, res: HttpResponse) {
    const acceptHeader = (req.headers?.accept as string | undefined) ?? "";
    const encoder = new EventEncoder(acceptHeader);

    const headers = {
      "Content-Type": encoder.getContentType(),
      Connection: "keep-alive",
      "Cache-Control": "no-cache",
    };

    if (typeof res.setHeader === "function") {
      Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
    } else if (typeof res.writeHead === "function") {
      res.writeHead(200, headers);
    }
    res.flushHeaders?.();

    try {
      const body = (await readBody(req)) as RunAgentInput;
      for await (const event of agent.run(body)) {
        res.write(encoder.encode(event));
      }
    } catch (error: unknown) {
      const fallback: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message:
          typeof error === "object" && error && "message" in error
            ? String((error as { message?: unknown }).message)
            : "Unknown error",
        code: "ENCODING_ERROR",
      };
      res.write(encoder.encode(fallback));
    } finally {
      res.end();
    }
  };
}

export function addStrandsEndpoint(
  app: {
    post: (
      path: string,
      handler: (req: HttpRequest, res: HttpResponse) => Promise<void> | void
    ) => unknown;
  },
  agent: StrandsAgent,
  path: string
): void {
  app.post(path, createStrandsHandler(agent));
}

export function createStrandsServer(agent: StrandsAgent, path = "/") {
  const handler = createStrandsHandler(agent);
  return createServer(async (req, res) => {
    const isPost = req.method?.toUpperCase() === "POST";
    const matchesPath = req.url?.split("?")[0] === path;
    if (isPost && matchesPath) {
      await handler(req as HttpRequest, res as HttpResponse);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
}
