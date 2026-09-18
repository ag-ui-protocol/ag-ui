import { test, expect } from "./test";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

test.describe("Shared State Feature", () => {
  test("[GitHub Copilot SDK] backend tool snapshots the recipe into shared state", async ({
    page,
  }) => {
    const sharedState = new SharedStatePage(page);
    await page.goto(`/${integrationId}/feature/shared_state`);
    await sharedState.openChat();
    await sharedState.sendMessage(
      'Please give me a pasta recipe of your choosing, but one of the ingredients should be "Pasta"',
    );
    await sharedState.loader();
    await sharedState.awaitIngredientCard("Pasta");
    await sharedState.getInstructionItems(sharedState.instructionsContainer);
  });

  test("[GitHub Copilot SDK] UI edits reach the agent through shared state", async ({ page }) => {
    const sharedState = new SharedStatePage(page);
    await page.goto(`/${integrationId}/feature/shared_state`);
    await sharedState.openChat();

    await sharedState.addIngredient.click();
    const card = page.locator(".ingredient-card").last();
    await card.locator(".ingredient-name-input").fill("Potatoes");
    await card.locator(".ingredient-amount-input").fill("12");

    await sharedState.sendMessage("Give me all the ingredients");
    await sharedState.loader();
    await expect(sharedState.agentMessage.getByText(/Potatoes/)).toBeVisible({ timeout: 30_000 });
  });
});
