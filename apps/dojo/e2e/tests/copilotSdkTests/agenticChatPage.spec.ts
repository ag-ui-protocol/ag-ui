import { test } from "./test";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

test("[GitHub Copilot SDK] Agentic Chat streams a response", async ({ page }) => {
  await page.goto(`/${integrationId}/feature/agentic_chat`);
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("What is the capital of France?");
  await chat.assertUserMessageVisible("What is the capital of France?");
  await chat.assertAgentReplyVisible(/Paris/i);
});
