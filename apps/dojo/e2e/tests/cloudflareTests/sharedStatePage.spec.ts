import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test("[Cloudflare] Shared State can add a todo item", async ({ page }) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/shared_state");

    const sharedState = new SharedStatePage(page);

    await sharedState.openChat();
    await sharedState.agentGreeting.waitFor({ state: "visible" });

    const todoItem = "Buy groceries";
    await sharedState.sendMessage(`Add todo: ${todoItem}`);
    await waitForAIResponse(page);

    // Check that todo appears in the list
    await expect(page.getByText(todoItem)).toBeVisible({ timeout: 10000 });
  });
});

test("[Cloudflare] Shared State can list todos", async ({ page }) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/shared_state");

    const sharedState = new SharedStatePage(page);

    await sharedState.openChat();
    await sharedState.agentGreeting.waitFor({ state: "visible" });

    // Add a todo
    await sharedState.sendMessage("Add todo: Test task");
    await waitForAIResponse(page);

    // Request list
    await sharedState.sendMessage("Show my todos");
    await waitForAIResponse(page);

    await sharedState.assertAgentReplyVisible(/Test task/i);
  });
});

test("[Cloudflare] Shared State persists todos across messages", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/shared_state");

    const sharedState = new SharedStatePage(page);

    await sharedState.openChat();
    await sharedState.agentGreeting.waitFor({ state: "visible" });

    // Add multiple todos
    await sharedState.sendMessage("Add todo: First task");
    await waitForAIResponse(page);

    await sharedState.sendMessage("Add todo: Second task");
    await waitForAIResponse(page);

    // Verify both appear
    await expect(page.getByText("First task")).toBeVisible();
    await expect(page.getByText("Second task")).toBeVisible();
  });
});
