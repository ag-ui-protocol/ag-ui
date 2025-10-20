import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

test("[Cloudflare] Tool-Based Gen UI generates a haiku", async ({ page }) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/tool_based_generative_ui");

    const toolGenUI = new ToolBaseGenUIPage(page);

    await toolGenUI.openChat();
    await toolGenUI.agentGreeting.waitFor({ state: "visible" });

    await toolGenUI.sendMessage("Write me a haiku about coding");
    await waitForAIResponse(page);

    // Should see a haiku response with Japanese and English lines
    const agentMessage = page
      .locator(".copilotKitAssistantMessage")
      .last();

    await expect(agentMessage).toBeVisible({ timeout: 15000 });
  });
});

test("[Cloudflare] Tool-Based Gen UI responds to different topics", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/tool_based_generative_ui");

    const toolGenUI = new ToolBaseGenUIPage(page);

    await toolGenUI.openChat();
    await toolGenUI.agentGreeting.waitFor({ state: "visible" });

    await toolGenUI.sendMessage("Create a haiku about nature");
    await waitForAIResponse(page);

    await toolGenUI.assertAgentReplyVisible(/haiku|nature|poem/i);
  });
});
