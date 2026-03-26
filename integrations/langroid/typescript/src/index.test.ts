import { LangroidHttpAgent } from "./index";
import { HttpAgent } from "@ag-ui/client";

describe("LangroidHttpAgent", () => {
  it("should be a subclass of HttpAgent", () => {
    expect(LangroidHttpAgent.prototype).toBeInstanceOf(HttpAgent);
  });

  it("should create an instance with a URL", () => {
    const agent = new LangroidHttpAgent({ url: "http://localhost:8000" });
    expect(agent).toBeInstanceOf(LangroidHttpAgent);
    expect(agent).toBeInstanceOf(HttpAgent);
  });
});
