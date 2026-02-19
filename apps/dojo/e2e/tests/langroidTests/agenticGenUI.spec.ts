import { test, expect } from "@playwright/test";
import { AgenticGenUIPage } from "../../pages/pydanticAIPages/AgenticUIGenPage";

test.describe("Agent Generative UI Feature", () => {
  // Flaky. Sometimes the steps render but never process.
  test("[Langroid] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(
      "/langroid/feature/agentic_generative_ui",
      { waitUntil: "domcontentloaded", timeout: 120000 }
    );
    // Wait for page to be ready - allow networkidle to fail gracefully
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await expect(genUIAgent.sendButton).toBeVisible({ timeout: 10000 });
    await genUIAgent.sendButton.click();
    await genUIAgent.assertAgentReplyVisible([/Hello/, /Hi/]);

    await genUIAgent.sendMessage("give me a plan to make brownies");
    await expect(genUIAgent.sendButton).toBeVisible({ timeout: 10000 });
    await genUIAgent.sendButton.click();
    // Wait for agent to process and emit state - give it more time for AI processing
    await expect(genUIAgent.agentPlannerContainer).toBeVisible({ timeout: 30000 });
    // Wait for steps to appear inside the container
    await expect(genUIAgent.agentPlannerContainer.getByTestId('task-step-text').first()).toBeVisible({ timeout: 10000 });
    await genUIAgent.plan();

    await page.waitForFunction(
      () => {
        const messages = Array.from(document.querySelectorAll('.copilotKitAssistantMessage'));
        const lastMessage = messages[messages.length - 1];
        const content = lastMessage?.textContent?.trim() || '';

        return messages.length >= 3 && content.length > 0;
      },
      { timeout: 30000 }
    );
  });

  test("[Langroid] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(
      "/langroid/feature/agentic_generative_ui",
      { waitUntil: "domcontentloaded", timeout: 120000 }
    );
    // Wait for page to be ready - allow networkidle to fail gracefully
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await expect(genUIAgent.sendButton).toBeVisible({ timeout: 10000 });
    await genUIAgent.sendButton.click();
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("Go to Mars");
    await expect(genUIAgent.sendButton).toBeVisible({ timeout: 10000 });
    await genUIAgent.sendButton.click();
    // Wait for agent to process and emit state - give it more time for AI processing
    await expect(genUIAgent.agentPlannerContainer).toBeVisible({ timeout: 30000 });
    // Wait for steps to appear inside the container
    await expect(genUIAgent.agentPlannerContainer.getByTestId('task-step-text').first()).toBeVisible({ timeout: 10000 });
    await genUIAgent.plan();

    await page.waitForFunction(
      () => {
        const messages = Array.from(document.querySelectorAll('.copilotKitAssistantMessage'));
        const lastMessage = messages[messages.length - 1];
        const content = lastMessage?.textContent?.trim() || '';

        return messages.length >= 3 && content.length > 0;
      },
      { timeout: 30000 }
    );
  });
});

