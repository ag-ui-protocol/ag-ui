import { test, expect } from "@playwright/test";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

const pageURL = "/adk-middleware/feature/tool_based_generative_ui";

test.describe("Tool Based Generative UI Feature", () => {
  test("[ADK Middleware] Haiku generation and display verification", async ({ page }) => {
    await page.goto(pageURL);

    const genAIAgent = new ToolBaseGenUIPage(page);

    await expect(genAIAgent.haikuAgentIntro).toBeVisible();
    await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
    await genAIAgent.checkGeneratedHaiku();
    await genAIAgent.checkHaikuDisplay(page);
  });

  test("[ADK Middleware] Haiku generation and UI consistency for two different prompts", async ({
    page,
  }) => {
    await page.goto(pageURL);

    const genAIAgent = new ToolBaseGenUIPage(page);

    await expect(genAIAgent.haikuAgentIntro).toBeVisible();

    const prompt1 = 'Generate Haiku for "I will always win"';
    await genAIAgent.generateHaiku(prompt1);
    await genAIAgent.checkGeneratedHaiku();
    const haiku1Content = await genAIAgent.extractChatHaikuContent(page);
    await genAIAgent.waitForMainDisplayHaiku(page, haiku1Content);

    const prompt2 = 'Generate Haiku for "The moon shines bright"';
    await genAIAgent.generateHaiku(prompt2);
    await genAIAgent.checkGeneratedHaiku();
    const haiku2Content = await genAIAgent.extractChatHaikuContent(page);

    // Verify haikus are different
    expect(haiku1Content).not.toBe(haiku2Content);

    await genAIAgent.waitForMainDisplayHaiku(page, haiku2Content);
  });
});
