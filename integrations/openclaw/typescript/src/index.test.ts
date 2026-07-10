import { describe, it, expect } from "vitest";
import { OpenClawAgent } from "./index";
import { HttpAgent } from "@ag-ui/client";

const URL = "http://localhost:8000/v1/clawg-ui/operator";

describe("OpenClawAgent", () => {
  it("is a subclass of HttpAgent", () => {
    expect(OpenClawAgent.prototype).toBeInstanceOf(HttpAgent);
  });

  it("constructs with just a url", () => {
    const agent = new OpenClawAgent({ url: URL });
    expect(agent).toBeInstanceOf(OpenClawAgent);
    expect(agent).toBeInstanceOf(HttpAgent);
  });

  it("maps gatewayToken to an Authorization: Bearer header", () => {
    const agent = new OpenClawAgent({ url: URL, gatewayToken: "secret-token" });
    expect(agent.headers.Authorization).toBe("Bearer secret-token");
  });

  it("sends no Authorization header when gatewayToken is omitted", () => {
    const agent = new OpenClawAgent({ url: URL });
    expect(agent.headers.Authorization).toBeUndefined();
  });

  it("gatewayToken wins over Authorization in headers, other headers preserved", () => {
    const agent = new OpenClawAgent({
      url: URL,
      gatewayToken: "token-wins",
      headers: { Authorization: "Bearer old", "X-Custom": "keep" },
    });
    expect(agent.headers.Authorization).toBe("Bearer token-wins");
    expect(agent.headers["X-Custom"]).toBe("keep");
  });
});
