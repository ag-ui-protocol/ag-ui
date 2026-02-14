import { test, expect, waitForAIResponse, retryOnAIFailure } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test.describe("Shared State Feature", () => {
  test("[MastraAgentLocal] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const sharedStateAgent = new SharedStatePage(page);

      await page.goto(
        "/mastra-agent-local/feature/shared_state"
      );

      await sharedStateAgent.openChat();
      await sharedStateAgent.sendMessage('Please give me a pasta recipe of your choosing, but one of the ingredients should be "Pasta"');
      await waitForAIResponse(page);
      await sharedStateAgent.awaitIngredientCard('Pasta');
      await sharedStateAgent.getInstructionItems(
        sharedStateAgent.instructionsContainer
      );
    });
  });

  test("[MastraAgentLocal] should share state between UI and chat", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const sharedStateAgent = new SharedStatePage(page);

      await page.goto(
        "/mastra-agent-local/feature/shared_state"
      );

      await sharedStateAgent.openChat();

      // Add new ingredient via UI
      await sharedStateAgent.addIngredient.click();

      // Fill in the new ingredient details
      const newIngredientCard = page.locator('.ingredient-card').last();
      await newIngredientCard.locator('.ingredient-name-input').fill('Potatoes');
      await newIngredientCard.locator('.ingredient-amount-input').fill('12');

      // Ask chat for all ingredients
      await sharedStateAgent.sendMessage("Give me all the ingredients");
      await waitForAIResponse(page);

      // Verify chat response includes both existing and new ingredients
      await expect(sharedStateAgent.agentMessage.getByText(/Potatoes/)).toBeVisible({ timeout: 15000 });
      await expect(sharedStateAgent.agentMessage.getByText(/12/)).toBeVisible({ timeout: 15000 });
      await expect(sharedStateAgent.agentMessage.getByText(/Carrots/)).toBeVisible({ timeout: 15000 });
      await expect(sharedStateAgent.agentMessage.getByText(/All-Purpose Flour/)).toBeVisible({ timeout: 15000 });
    });
  });
});
