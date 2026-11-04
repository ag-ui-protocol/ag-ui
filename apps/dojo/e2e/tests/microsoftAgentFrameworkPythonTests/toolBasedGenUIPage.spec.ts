import { test, expect } from "../../test-isolation-helper";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

// The example's ui_generator agent declares generate_haiku declaration-only
// (func=None), so the page's frontend tool renders it. Tool calls come from the
// shared tool-based-gen-ui fixtures.
const pageURL =
  "/microsoft-agent-framework-python/feature/tool_based_generative_ui";

test("[MS Agent Framework Python] Haiku generation and display verification", async ({
  page,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});

test("[MS Agent Framework Python] Haiku generation and UI consistency for two different prompts", async ({
  page,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  await genAIAgent.generateHaiku('Generate Haiku for "The moon shines bright"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});
