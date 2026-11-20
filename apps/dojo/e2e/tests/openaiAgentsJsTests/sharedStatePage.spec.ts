import { test } from "../../test-isolation-helper";
import { SharedStatePage } from "../../featurePages/SharedStatePage";

test("[OpenAI Agents JS] Shared State creates a recipe from chat", async ({
  page,
}) => {
  test.slow();
  const sharedState = new SharedStatePage(page);

  await page.goto("/openai-agents-js/feature/shared_state");
  await sharedState.openChat();
  await sharedState.sendMessage(
    'Give me a pasta recipe with an ingredient named "Pasta".',
  );
  await sharedState.loader();
  await sharedState.awaitIngredientCard("Pasta");
  await sharedState.getInstructionItems(sharedState.instructionsContainer);
});
