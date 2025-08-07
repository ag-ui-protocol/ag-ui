import { test, expect } from "@playwright/test";
import { AgenticGenUIPage } from "../../pages/serverStarterAllFeaturesPages/AgenticUIGenPage";

test.describe("Agent Generative UI Feature", () => {
  test("[Server Starter all features] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(
      "https://ag-ui-dojo-nine.vercel.app/server-starter-all-features/feature/agentic_generative_ui"
    );

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.sendButton.click();
    await page.waitForTimeout(10000); // Sleep for 10 seconds
    await genUIAgent.plan();
  });
});