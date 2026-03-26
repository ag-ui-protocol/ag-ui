import { test, expect } from "@playwright/test";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test.describe("Shared State Feature", () => {
  test("[Claude Agent SDK TypeScript] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    test.slow(); // Claude Agent SDK responses go through CLI subprocess
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/claude-agent-sdk-typescript/feature/shared_state");

    await sharedStateAgent.openChat();
    await sharedStateAgent.sendMessage(
      'Please give me a pasta recipe of your choosing, but one of the ingredients should be "Pasta"'
    );
    await sharedStateAgent.loader();

    // Use longer timeout than SharedStatePage.awaitIngredientCard default (15s)
    // Claude Agent SDK responses go through a CLI subprocess and are slower
    await page.waitForFunction(
      (ingredientName) => {
        const inputs = document.querySelectorAll('.ingredient-card input.ingredient-name-input');
        return Array.from(inputs).some(
          (input: HTMLInputElement) => input.value.toLowerCase().includes(ingredientName.toLowerCase())
        );
      },
      "Pasta",
      { timeout: 60000 }
    );

    await sharedStateAgent.getInstructionItems(
      sharedStateAgent.instructionsContainer
    );
  });

  test("[Claude Agent SDK TypeScript] should share state between UI and chat", async ({
    page,
  }) => {
    test.slow(); // Claude Agent SDK responses go through CLI subprocess
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/claude-agent-sdk-typescript/feature/shared_state");

    await sharedStateAgent.openChat();

    // Add new ingredient via UI
    await sharedStateAgent.addIngredient.click();

    // Fill in the new ingredient details
    const newIngredientCard = page.locator(".ingredient-card").last();
    await newIngredientCard.locator(".ingredient-name-input").fill("Potatoes");
    await newIngredientCard.locator(".ingredient-amount-input").fill("12");

    // Wait for UI to update
    await page.waitForTimeout(1000);

    // Ask chat for all ingredients
    await sharedStateAgent.sendMessage("Give me all the ingredients");
    await sharedStateAgent.loader();

    // Verify chat response includes the new ingredient
    await expect(
      sharedStateAgent.agentMessage.getByText(/Potatoes/)
    ).toBeVisible({ timeout: 30000 });
  });
});
