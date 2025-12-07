import { Readable } from "stream";
import {
  addStrandsEndpoint,
  createStrandsHandler,
  createStrandsServer,
} from "../endpoint";
import { EventType } from "../types";

jest.mock("http", () => ({
  createServer: jest.fn((handler) => ({ __handler: handler })),
}));

type Headers = Record<string, string>;

function createRequest(
  body: unknown,
  headers: Headers = {},
  overrides: Record<string, unknown> = {}
) {
  const payload =
    body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const stream = Readable.from([payload]);
  return Object.assign(stream, { headers }, overrides);
}

function createResponse(options: { useWriteHead?: boolean } = {}) {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res: any = {
    headers,
    chunks,
    statusCode: 200,
    write: jest.fn((chunk: string) => {
      chunks.push(chunk);
    }),
    end: jest.fn(),
    flushHeaders: jest.fn(),
  };
  if (options.useWriteHead) {
    res.writeHead = jest.fn((_status: number, head: Record<string, string>) => {
      Object.assign(headers, head);
    });
  } else {
    res.setHeader = jest.fn((key: string, value: string) => {
      headers[key] = value;
    });
  }
  return res;
}

describe("createStrandsHandler", () => {
  it("streams newline-delimited JSON when requested", async () => {
    const agent = {
      run: jest.fn(async function* () {
        yield { type: EventType.RUN_STARTED };
        yield { type: EventType.RUN_FINISHED };
      }),
    };

    const handler = createStrandsHandler(agent as any);
    const body = { thread_id: "thread-1", messages: [] };
    const req = createRequest(body, { accept: "application/json" });
    const res = createResponse();

    await handler(req as any, res as any);

    expect(agent.run).toHaveBeenCalledWith(
      expect.objectContaining(body)
    );
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
    expect(res.write).toHaveBeenNthCalledWith(
      1,
      `${JSON.stringify({ type: EventType.RUN_STARTED })}\n`
    );
    expect(res.write).toHaveBeenNthCalledWith(
      2,
      `${JSON.stringify({ type: EventType.RUN_FINISHED })}\n`
    );
    expect(res.end).toHaveBeenCalled();
  });

  it("emits a fallback RUN_ERROR event when the agent throws", async () => {
    const agent = {
      run: jest.fn(async function* () {
        throw new Error("boom");
      }),
    };

    const handler = createStrandsHandler(agent as any);
    const req = createRequest({}, {});
    const res = createResponse();

    await handler(req as any, res as any);

    expect(agent.run).toHaveBeenCalled();
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.write).toHaveBeenCalledTimes(1);
    const payload = res.write.mock.calls[0][0] as string;
    expect(payload.startsWith("data: ")).toBe(true);
    expect(payload).toContain(EventType.RUN_ERROR);
    expect(payload).toContain("ENCODING_ERROR");
    expect(payload.toLowerCase()).toContain("boom");
  });

  it("passes through raw string bodies when JSON parsing fails", async () => {
    const agent = {
      run: jest.fn(async function* () {
        yield { type: EventType.RUN_FINISHED };
      }),
    };
    const handler = createStrandsHandler(agent as any);
    const req = createRequest("not-json", {});
    const res = createResponse();

    await handler(req as any, res as any);
    expect(agent.run).toHaveBeenCalledWith("not-json");
  });

  it("respects pre-parsed req.body and writeHead fallback", async () => {
    const agent = {
      run: jest.fn(async function* () {
        yield { type: EventType.RUN_FINISHED };
      }),
    };
    const handler = createStrandsHandler(agent as any);
    const body = { thread_id: "inline" };
    const req = { body, headers: {} };
    const res = createResponse({ useWriteHead: true });

    await handler(req as any, res as any);

    expect(agent.run).toHaveBeenCalledWith(body);
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": expect.any(String) })
    );
  });

  it("defaults to an empty object when the request body is empty", async () => {
    const agent = {
      run: jest.fn(async function* () {
        yield { type: EventType.RUN_FINISHED };
      }),
    };

    const handler = createStrandsHandler(agent as any);
    const req = createRequest(undefined, {});
    const res = createResponse();

    await handler(req as any, res as any);

    expect(agent.run).toHaveBeenCalledWith({});
  });

  it("emits an unknown error message when thrown value is not an Error", async () => {
    const agent = {
      run: jest.fn(async function* () {
        throw "boom"; // eslint-disable-line no-throw-literal
      }),
    };

    const handler = createStrandsHandler(agent as any);
    const req = createRequest({}, {});
    const res = createResponse();

    await handler(req as any, res as any);
    const payload = res.write.mock.calls[0][0] as string;
    expect(payload).toContain("Unknown error");
  });
});

describe("endpoint helpers", () => {
  it("registers the POST handler through addStrandsEndpoint", () => {
    const app = { post: jest.fn() };
    const agent = {} as any;

    addStrandsEndpoint(app as any, agent, "/hook");

    expect(app.post).toHaveBeenCalledWith("/hook", expect.any(Function));
  });

  it("creates a server that routes matching POST requests", async () => {
    const createServerMock = jest.requireMock("http")
      .createServer as jest.Mock;
    createServerMock.mockClear();

    const agent = {
      run: jest.fn(async function* () {
        yield { type: EventType.RUN_FINISHED };
      }),
    };

    const server = createStrandsServer(agent as any, "/hook");
    expect(server).toHaveProperty("__handler");

    const handler = createServerMock.mock.calls[0]?.[0];
    expect(typeof handler).toBe("function");

    const matchReq = createRequest({}, {}, { method: "POST", url: "/hook" });
    const matchRes = createResponse();
    await handler(matchReq as any, matchRes as any);
    expect(agent.run).toHaveBeenCalled();

    const missReq = createRequest({}, {}, { method: "GET", url: "/hook" });
    const missRes = createResponse();
    await handler(missReq as any, missRes as any);
    expect(missRes.statusCode).toBe(404);
    expect(missRes.end).toHaveBeenCalled();
  });

  it("uses the default path when none is provided", async () => {
    const createServerMock = jest.requireMock("http")
      .createServer as jest.Mock;
    createServerMock.mockClear();

    const agent = {
      run: jest.fn(async function* () {
        yield { type: EventType.RUN_FINISHED };
      }),
    };

    const server = createStrandsServer(agent as any);
    expect(server).toHaveProperty("__handler");

    const handler = createServerMock.mock.calls[0]?.[0];
    const req = createRequest({}, {}, { method: "POST", url: "/" });
    const res = createResponse();
    await handler(req as any, res as any);

    expect(agent.run).toHaveBeenCalled();
  });
});
