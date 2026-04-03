import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Strands] Agentic Chat Reasoning sends and receives a message", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/agentic_chat_reasoning");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am duaa");

  await chat.assertUserMessageVisible("Hi, I am duaa");
  await chat.assertAgentReplyVisible(/Hello duaa/i);
});

test("[Strands] Agentic Chat Reasoning changes background on message", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/agentic_chat_reasoning");

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

  await expect.poll(getBackground).not.toBe(initialBackground);
});
