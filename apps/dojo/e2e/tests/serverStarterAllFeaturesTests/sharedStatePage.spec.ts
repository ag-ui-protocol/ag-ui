import { test, expect, retryOnAIFailure } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";
import { sendChatMessage } from "../../utils/copilot-actions";

test.describe("Shared State Feature", () => {
  test("[Server Starter all features] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const sharedStateAgent = new SharedStatePage(page);

      await page.goto(
        "/server-starter-all-features/feature/shared_state"
      );

      await sharedStateAgent.openChat();
      // Use sendChatMessage to avoid sendAndAwaitResponse timeout;
      // loader() and awaitIngredientCard handle the waiting.
      await sendChatMessage(page, 'Please give me a pasta recipe of your choosing, but one of the ingredients should be "Pasta"');
      await sharedStateAgent.loader();
      await sharedStateAgent.awaitIngredientCard('Salt');
      await sharedStateAgent.getInstructionItems(
        sharedStateAgent.instructionsContainer
      );
    });
  });

  test("[Server Starter all features] should share state between UI and chat", async ({
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

      await expect(newIngredientCard.locator('.ingredient-name-input')).toHaveValue('Potatoes');
      await expect(newIngredientCard.locator('.ingredient-amount-input')).toHaveValue('12');

      // Use sendChatMessage to avoid sendAndAwaitResponse timeout;
      // loader() and awaitIngredientCard handle the waiting.
      await sendChatMessage(page, "Give me all the ingredients");
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
