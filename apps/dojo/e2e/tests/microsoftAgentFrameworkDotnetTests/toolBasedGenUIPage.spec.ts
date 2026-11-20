import { test, expect } from "../../test-isolation-helper";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

// generate_haiku is a frontend tool registered by the page. Tool calls come from
// the shared tool-based-gen-ui fixtures. Re-check after PNI-515 (MAF 1.23).
const pageURL =
  "/microsoft-agent-framework-dotnet/feature/tool_based_generative_ui";

test("[MS Agent Framework .NET] Haiku generation and display verification", async ({
  page,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});

test("[MS Agent Framework .NET] Haiku generation and UI consistency for two different prompts", async ({
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
