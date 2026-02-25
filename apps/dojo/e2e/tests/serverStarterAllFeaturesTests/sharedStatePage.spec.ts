import { test, expect, retryOnAIFailure } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test.describe("Shared State Feature", () => {
  // Agent does not respond with assistant messages for this integration.
  test.fixme("[Server Starter all features] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const sharedStateAgent = new SharedStatePage(page);

      await page.goto(
        "/server-starter-all-features/feature/shared_state"
      );

      await sharedStateAgent.openChat();
      await sharedStateAgent.sendMessage('Please give me a pasta recipe of your choosing, but one of the ingredients should be "Pasta"');
      await sharedStateAgent.loader();
      await sharedStateAgent.awaitIngredientCard('Salt');
      await sharedStateAgent.getInstructionItems(
        sharedStateAgent.instructionsContainer
      );
    });
  });

  // Agent does not respond with assistant messages for this integration.
  test.fixme("[Server Starter all features] should share state between UI and chat", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const sharedStateAgent = new SharedStatePage(page);

      await page.goto(
        "/server-starter-all-features/feature/shared_state"
      );

      await sharedStateAgent.openChat();

      // Add new ingredient via UI
      await sharedStateAgent.addIngredient.click();

      // Fill in the new ingredient details
      const newIngredientCard = page.locator('.ingredient-card').last();
      await newIngredientCard.locator('.ingredient-name-input').fill('Potatoes');
      await newIngredientCard.locator('.ingredient-amount-input').fill('12');

      // Wait for UI to update
      await page.waitForTimeout(1000);

      // Ask chat for all ingredients
      await sharedStateAgent.sendMessage("Give me all the ingredients");
      await sharedStateAgent.loader();

      // Verify hardcoded ingredients
      await sharedStateAgent.awaitIngredientCard('chicken breast');
      await sharedStateAgent.awaitIngredientCard('chili powder');
      await sharedStateAgent.awaitIngredientCard('Salt');
      await sharedStateAgent.awaitIngredientCard('Lettuce leaves');

      expect(await sharedStateAgent.getInstructionItems(sharedStateAgent.instructionsContainer)).toBe(3);
    });
  });
});
