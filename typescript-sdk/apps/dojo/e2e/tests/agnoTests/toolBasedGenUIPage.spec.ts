import { test, expect } from "@playwright/test";
import { ToolBaseGenUIPage } from "../../pages/agnoPages/ToolBaseGenUIPage";

const pageURL =
  "https://ag-ui-dojo-nine.vercel.app/agno/feature/tool_based_generative_ui";

test('[Agno] Haiku generation and display verification', async ({
  page,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});

test('[Agno] Haiku generation and UI consistency for two different prompts', async ({
  page,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  const prompt1 = 'Generate Haiku for "I will always win"';
  await genAIAgent.generateHaiku(prompt1);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  const prompt2 = 'Generate Haiku for "The moon shines bright"';
  await genAIAgent.generateHaiku(prompt2);
  await genAIAgent.checkGeneratedHaiku(); // Wait for second haiku to be generated
  await genAIAgent.checkHaikuDisplay(page); // Now compare the second haiku
});