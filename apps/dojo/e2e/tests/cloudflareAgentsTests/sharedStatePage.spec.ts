import { test, expect } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

const PAGE_URL = "/cloudflare-agents/feature/shared_state";

// The agent's state is the Durable Object's state. The Worker's
// generate_recipe tool writes the recipe into it (the page gets a
// STATE_SNAPSHOT), and the page's own edits reach the model through the
// shared state section of the agent's instructions.
test.describe("Shared State Feature", () => {
  test("[Cloudflare Agents] should interact with the chat to get a recipe on prompt", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await gotoAndAwaitRuntimeInfo(page, PAGE_URL);

    await sharedStateAgent.openChat();
    await sharedStateAgent.sendMessage(
      'Please give me a pasta recipe of your choosing, but one of the ingredients should be "Pasta"',
    );
    await sharedStateAgent.loader();
    await sharedStateAgent.awaitIngredientCard("Pasta");
    await sharedStateAgent.getInstructionItems(
      sharedStateAgent.instructionsContainer,
    );
  });

  test("[Cloudflare Agents] should share state between UI and chat", async ({
    page,
  }) => {
    const sharedStateAgent = new SharedStatePage(page);

    await gotoAndAwaitRuntimeInfo(page, PAGE_URL);

    await sharedStateAgent.openChat();

    // Add new ingredient via UI
    await sharedStateAgent.addIngredient.click();

    // Fill in the new ingredient details
    const newIngredientCard = page.locator(".ingredient-card").last();
    await newIngredientCard.locator(".ingredient-name-input").fill("Potatoes");
    await newIngredientCard.locator(".ingredient-amount-input").fill("12");

    // Wait for UI to update
    await page.waitForTimeout(1000);

    // The fixture lists the ingredients it finds in the shared state the
    // agent put into its instructions, so the UI's additions only show up
    // here if the state reached the model.
    await sharedStateAgent.sendMessage("Give me all the ingredients");
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
