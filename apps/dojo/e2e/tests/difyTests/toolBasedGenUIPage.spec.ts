import { test, expect } from "@playwright/test";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

const pageURL = "/dify/feature/tool_based_generative_ui";

const hasDifyEnv = Boolean(process.env.DIFY_API_KEY);
test.skip(!hasDifyEnv, "DIFY_API_KEY not set");

test("[Dify] Haiku generation and display verification", async ({ page }) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "Morning mist"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});
