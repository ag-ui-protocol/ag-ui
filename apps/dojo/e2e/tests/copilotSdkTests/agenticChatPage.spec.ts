import { test } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

test("[GitHub Copilot SDK] Agentic Chat streams a response", async ({ page }) => {
  await page.goto(`/${integrationId}/feature/agentic_chat`);
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("Say hello in one sentence.");
  await chat.assertUserMessageVisible("Say hello in one sentence.");
  await chat.assertAgentReplyVisible(/hello|hi|greeting/i);
});
