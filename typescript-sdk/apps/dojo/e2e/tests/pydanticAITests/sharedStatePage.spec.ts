import { test, expect } from "@playwright/test";
import { SharedStatePage } from "../../pages/pydanticAIPages/SharedStatePage";

test.describe("Shared State Feature", () => {
  test("[PydanticAI] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    // Update URL to new domain
    await page.goto(
      "https://ag-ui-dojo-nine.vercel.app/pydantic-ai/feature/shared_state"
    );

    await sharedStateAgent.openChat();
    await sharedStateAgent.sendMessage("give me recipe for pasta");
    await sharedStateAgent.loader();
    await sharedStateAgent.getIngredientCard(/Pasta/);
    await sharedStateAgent.getInstructionItems(
      sharedStateAgent.instructionsContainer
    );
  });

  test("[PydanticAI] should share state between UI and chat", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto(
      "https://ag-ui-dojo-nine.vercel.app/pydantic-ai/feature/shared_state"
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

    // Verify chat response includes both existing and new ingredients
    await expect(sharedStateAgent.agentMessage.getByText(/Potatoes/)).toBeVisible();
    await expect(sharedStateAgent.agentMessage.getByText(/12/)).toBeVisible();
    await expect(sharedStateAgent.agentMessage.getByText(/Carrots/)).toBeVisible();
    await expect(sharedStateAgent.agentMessage.getByText(/All-Purpose Flour/)).toBeVisible();
  });
});