import type { Page, Response } from "@playwright/test";
import { expect, test } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

const AGENTIC_CHAT_URL = "/cloudflare-agents/feature/agentic_chat";

/** Resolves with the next agent run's SSE response from the Dojo runtime. */
function nextRunStream(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/api/copilotkit") &&
      (response.headers()["content-type"] ?? "").includes("text/event-stream"),
  );
}

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice("data:".length).trim())];
      } catch {
        return [];
      }
    });
}

test("[Cloudflare Agents] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, AGENTIC_CHAT_URL);

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am Duaa");

  await chat.assertUserMessageVisible("Hi, I am Duaa");
  await chat.assertAgentReplyVisible(/Hello Duaa/i);
});

test("[Cloudflare Agents] RUN_STARTED declares protocolVersion 1.0", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, AGENTIC_CHAT_URL);

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  const run = nextRunStream(page);
  await chat.sendMessage("Hi, I am Duaa");
  await chat.assertAgentReplyVisible(/Hello Duaa/i);

  const events = sseEvents(await (await run).text());
  const runStarted = events.find((event) => event.type === "RUN_STARTED");
  expect(runStarted, "RUN_STARTED event in the run stream").toBeDefined();
  expect(runStarted?.protocolVersion).toBe("1.0");
});

test("[Cloudflare Agents] Agentic Chat calls a frontend tool to change the background", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, AGENTIC_CHAT_URL);

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  const backgroundContainer = page.locator(
    '[data-testid="background-container"]',
  );
  const getBackground = () =>
    backgroundContainer.evaluate((el) => el.style.background);
  const initialBackground = await getBackground();

  await chat.sendMessage("Hi change the background color to blue");
  await chat.assertUserMessageVisible("Hi change the background color to blue");

  await expect.poll(getBackground).toContain("blue");
  expect(await getBackground()).not.toBe(initialBackground);
});
