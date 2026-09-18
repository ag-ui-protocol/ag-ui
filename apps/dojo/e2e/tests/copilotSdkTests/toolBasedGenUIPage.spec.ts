import { test, expect } from "./test";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

test("[GitHub Copilot SDK] Tool Based Generative UI renders haikus for two prompts", async ({
  page,
}) => {
  await page.goto(`/${integrationId}/feature/tool_based_generative_ui`);
  const genAIAgent = new ToolBaseGenUIPage(page);
  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  await genAIAgent.generateHaiku('Generate Haiku for "The moon shines bright"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});
