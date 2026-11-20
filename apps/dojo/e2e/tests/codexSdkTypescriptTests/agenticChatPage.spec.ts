import { expect } from "@playwright/test";
import { test } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

const route = "/codex-sdk-typescript/feature/agentic_chat";

function toolsIn(value: unknown): unknown[][] {
  if (Array.isArray(value)) return value.flatMap(toolsIn);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "tools" && Array.isArray(child) ? [child] : toolsIn(child),
  );
}

test("[Codex SDK] chat greets and retains a name across turns", async ({
  page,
}) => {
  const submittedTools: unknown[][] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "POST" ||
      !request.url().includes("/api/copilotkit/")
    )
      return;
    try {
      submittedTools.push(...toolsIn(request.postDataJSON()));
    } catch {}
  });
  await page.goto(route);
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("Hi, my name is Alex");
  await chat.assertAgentReplyVisible(/Hello|Hi|Alex/i);
  await chat.sendMessage("What is my name?");
  await expect(chat.agentMessage.last()).toContainText("Your name is Alex.");
  expect(submittedTools.length).toBeGreaterThan(0);
  expect(submittedTools.every((tools) => tools.length === 0)).toBe(true);
});

test("[Codex SDK] a new browser conversation has independent memory", async ({
  page,
  context,
}) => {
  await page.goto(route);
  const first = new AgenticChatPage(page);
  await first.openChat();
  await first.sendMessage("Hi, my name is Alex");
  const other = await context.newPage();
  await other.goto(route);
  const second = new AgenticChatPage(other);
  await second.openChat();
  await second.sendMessage("What is my name?");
  await expect(second.agentMessage.last()).not.toContainText("Alex");
  await other.close();
});

test("[Codex SDK] a terminal failure appears in chat", async ({ page }) => {
  await page.goto(route);
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.chatInput.fill("codex-test-error");
  await chat.sendButton.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Codex could not complete this run." }),
  ).toBeVisible();
});
