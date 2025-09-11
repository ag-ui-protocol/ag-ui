import { test, expect } from "@playwright/test";
import { AgenticGenUIPage } from "../../pages/serverStarterAllFeaturesPages/AgenticUIGenPage";

// Skip all tests in this file when CLOUD_AGENTS is set
test.skip(!!process.env.CLOUD_AGENTS, 'Skipping Server Starter all features tests when CLOUD_AGENTS is set');

test.describe("Agent Generative UI Feature", () => {
  test("[Server Starter all features] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(
      "/server-starter-all-features/feature/agentic_generative_ui"
    );

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.sendButton.click();
    await expect(genUIAgent.agentPlannerContainer).toBeVisible({ timeout: 15000 });
    
    await genUIAgent.plan();
    await expect(genUIAgent.agentPlannerContainer).toBeVisible({ timeout: 8000 });
  });
});