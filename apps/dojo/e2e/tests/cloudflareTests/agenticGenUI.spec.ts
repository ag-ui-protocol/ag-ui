import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Cloudflare] Agentic Gen UI breaks down tasks into steps", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/agentic_generative_ui");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    await chat.sendMessage("How do I make a sandwich?");
    await waitForAIResponse(page);

    // Should see numbered steps
    await expect(page.getByText(/1\./)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/2\./)).toBeVisible({ timeout: 5000 });
  });
});

test("[Cloudflare] Agentic Gen UI generates multiple steps", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/agentic_generative_ui");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    await chat.sendMessage("What are the steps to learn TypeScript?");
    await waitForAIResponse(page);

    // Should see a structured list of steps
    const agentMessage = page.locator(".copilotKitAssistantMessage").last();
    await expect(agentMessage).toContainText(/TypeScript|steps/i, {
      timeout: 15000,
    });
  });
});
