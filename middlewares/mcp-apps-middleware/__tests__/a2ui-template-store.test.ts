import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { A2UI_MIME_TYPE } from "../src/a2ui/protocol";
import { TemplateStore } from "../src/a2ui/template-store";
import { customerTemplate } from "./a2ui/fixtures";

async function read(uri: string): Promise<ReadResourceResult> {
  return {
    contents: [
      { uri, mimeType: A2UI_MIME_TYPE, text: JSON.stringify(customerTemplate) },
    ],
  };
}

describe("TemplateStore", () => {
  it("removes expired entries", async () => {
    const store = new TemplateStore({ ttlMs: 0, maxPayloadBytes: 64 * 1024 });

    await store.load("server", "a2ui://first", read);
    await store.load("server", "a2ui://second", read);
    await store.load("server", "a2ui://third", read);

    expect(store.size).toBe(1);
  });

  it("keeps entries that have not expired", async () => {
    const store = new TemplateStore({
      ttlMs: 60_000,
      maxPayloadBytes: 64 * 1024,
    });

    await store.load("server", "a2ui://first", read);
    await store.load("server", "a2ui://second", read);

    expect(store.size).toBe(2);
  });
});
