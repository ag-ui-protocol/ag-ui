import { expect, test } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

const AGENTIC_CHAT_URL = "/cloudflare-agents/feature/agentic_chat";

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
