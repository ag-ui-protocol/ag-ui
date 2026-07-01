import { test, expect } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test.describe("Shared State Feature", () => {
  test("[StrandsTS] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/aws-strands-typescript/feature/shared_state");

    await sharedStateAgent.openChat();
    await sharedStateAgent.sendMessage(
      'Please give me a pasta recipe of your choosing, but one of the ingredients should be "Pasta". Not a type of pasta, exactly the word "Pasta".',
    );
    await sharedStateAgent.loader();
    await sharedStateAgent.awaitIngredientCard("Pasta");
    await sharedStateAgent.getInstructionItems(
      sharedStateAgent.instructionsContainer,
    );
  });

  test("[StrandsTS] should share state between UI and chat", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await page.goto("/aws-strands-typescript/feature/shared_state");

    await sharedStateAgent.openChat();

    await sharedStateAgent.addIngredient.click();

    const newIngredientCard = page.locator(".ingredient-card").last();
    await newIngredientCard.locator(".ingredient-name-input").fill("Potatoes");
    await newIngredientCard.locator(".ingredient-amount-input").fill("12");

    await page.waitForTimeout(1000);

    await sharedStateAgent.sendMessage("Please list all of the ingredients");
    await sharedStateAgent.loader();

    await expect(
      sharedStateAgent.agentMessage.getByText(/Potatoes/),
    ).toBeVisible();
    await expect(sharedStateAgent.agentMessage.getByText(/12/)).toBeVisible();
    await expect(
      sharedStateAgent.agentMessage.getByText(/Carrots/),
    ).toBeVisible();
    await expect(
      sharedStateAgent.agentMessage.getByText(/All-Purpose Flour/),
    ).toBeVisible();
  });
});
