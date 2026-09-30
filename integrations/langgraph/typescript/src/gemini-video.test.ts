import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { type UserMessage } from "@ag-ui/client";
import { aguiMessagesToLangChain } from "./utils";

// Exercise the installed Gemini translator, intercepting only its HTTP transport.
// No provider credentials or network calls are needed for this regression.
afterEach(() => vi.unstubAllGlobals());

describe("Gemini video conversion compatibility", () => {
  it.each(["data", "url"] as const)(
    "sends a video %s source as Gemini inlineData",
    async (sourceType) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
                index: 0,
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetch);
      const message: UserMessage = {
        id: "video",
        role: "user",
        content: [
          {
            type: "video",
            source: {
              type: sourceType,
              value:
                sourceType === "data" ? "AAAA" : "data:video/mp4;base64,AAAA",
              mimeType: "video/mp4",
            },
          },
        ],
      };
      const content = aguiMessagesToLangChain([message])[0].content;
      const model = new ChatGoogleGenerativeAI({
        model: "gemini-2.5-flash",
        apiKey: "test-key",
        maxRetries: 0,
      });
      await model.invoke([new HumanMessage({ content })]);
      expect(fetch).toHaveBeenCalledOnce();
      const body = fetch.mock.calls[0][1]?.body;
      if (typeof body !== "string")
        throw new Error("Expected JSON request body");
      expect(JSON.parse(body).contents).toEqual([
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "video/mp4", data: "AAAA" } }],
        },
      ]);
    },
  );
});
