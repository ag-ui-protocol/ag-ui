import { expect } from "@playwright/test";
import type { RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { test } from "../../test-isolation-helper";

const flutterUrl = process.env.CODEX_FLUTTER_URL;

test.describe("[Codex SDK] standalone Flutter chat", () => {
  test.skip(
    !flutterUrl,
    "Set CODEX_FLUTTER_URL to the compiled Codex Flutter app.",
  );

  for (const scenario of [
    {
      name: "retains a name across two turns",
      first: "Hi, my name is Alex",
      replies: ["Hello Alex. I will remember your name."],
      followUp: "What is my name?",
      answer: "Your name is Alex.",
    },
    {
      name: "serializes overlapping native items and continues their history",
      first: "[fixture:interleaved]",
      replies: ["First reply.", "Second reply."],
      followUp: "Continue the conversation",
      answer: "Hello! How can I help you?",
    },
  ]) {
    test(scenario.name, async ({ page }, testInfo) => {
      if (!flutterUrl) return;
      const requests: RunAgentInput[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith("/agentic_chat")
        ) {
          requests.push(RunAgentInputSchema.parse(request.postDataJSON()));
        }
      });
      await page.goto(flutterUrl);
      const input = page.getByRole("textbox", { name: "Type a message..." });
      await expect(async () => {
        if (!(await input.count())) {
          await page.locator("flt-semantics-placeholder").press("Enter");
        }
        expect(await input.count()).toBe(1);
      }).toPass({ timeout: 10000 });
      async function send(text: string, count: number) {
        const completed = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith("/agentic_chat"),
        );
        await expect(input).toBeEditable();
        await input.click();
        const editor = page.locator(
          'textarea[data-semantics-role="text-field"]',
        );
        await expect(editor).toBeFocused();
        await expect(editor).toHaveAttribute(
          "placeholder",
          "Type a message...",
        );
        await expect(async () => {
          await editor.fill("");
          await editor.pressSequentially(text, { delay: 10 });
          await expect(editor).toHaveValue(text, { timeout: 1000 });
        }).toPass({ timeout: 10000 });
        await expect(async () => {
          if (requests.length < count) await editor.press("Enter");
          expect(requests).toHaveLength(count);
        }).toPass({ timeout: 10000 });
        await (await completed).finished();
      }
      await send(scenario.first, 1);
      for (const reply of scenario.replies) {
        await expect(page.getByText(reply, { exact: true })).toBeVisible();
      }
      await send(scenario.followUp, 2);
      await expect(
        page.getByText(scenario.answer, { exact: true }),
      ).toBeVisible();

      expect(requests).toHaveLength(2);
      expect(requests[1].threadId).toBe(requests[0].threadId);
      expect(requests[1].runId).not.toBe(requests[0].runId);
      expect(requests.map((request) => request.tools)).toEqual([[], []]);
      expect(requests[1].messages.map((message) => message.role)).toEqual([
        "user",
        ...scenario.replies.map(() => "assistant"),
        "user",
      ]);
      expect(
        requests[1].messages.slice(1, -1).map((message) => message.content),
      ).toEqual(scenario.replies);
      const assistantIds = requests[1].messages
        .slice(1, -1)
        .map((message) => message.id);
      expect(new Set(assistantIds).size).toBe(scenario.replies.length);
      expect(
        assistantIds.every((id) => typeof id === "string" && id.length > 0),
      ).toBe(true);
      await expect(input).toBeEditable();
      await page.screenshot({
        path: testInfo.outputPath("flutter-two-turns.png"),
      });
      await testInfo.attach("requests", {
        body: JSON.stringify(requests, null, 2),
        contentType: "application/json",
      });
    });
  }
});
