import { test, expect } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/adkMiddlewarePages/PredictiveStateUpdatesPage";

// TODO: Re-enable when ADK middleware agent is uncommented in agents.ts and menu.ts
test.describe.skip("Predictive State Updates Feature", () => {
  test("[ADK Middleware] should interact with agent and approve asked changes", async ({
    page,
  }) => {
    const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

    await page.goto("/adk-middleware/feature/predictive_state_updates");

    await predictiveStateUpdates.openChat();
    await predictiveStateUpdates.sendMessage(
      "Give me a story for a dragon called Atlantis in document",
    );
    await page.waitForTimeout(2000);
    await predictiveStateUpdates.getPredictiveResponse();
    await predictiveStateUpdates.getUserApproval();
    await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
    const dragonName =
      await predictiveStateUpdates.verifyAgentResponse("Atlantis");
    expect(dragonName).not.toBeNull();

    // Send update to change the dragon name
    await predictiveStateUpdates.sendMessage("Change dragon name to Lola");
    await page.waitForTimeout(2000);
    await predictiveStateUpdates.verifyHighlightedText();
    await predictiveStateUpdates.getUserApproval();
    await expect(
      predictiveStateUpdates.confirmedChangesResponse.nth(1),
    ).toBeVisible();
    const dragonNameNew =
      await predictiveStateUpdates.verifyAgentResponse("Lola");
    expect(dragonNameNew).not.toBe(dragonName);
  });

  test("[ADK Middleware] should interact with agent and reject asked changes", async ({
    page,
  }) => {
    const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

    await page.goto("/adk-middleware/feature/predictive_state_updates");

    await predictiveStateUpdates.openChat();

    await predictiveStateUpdates.sendMessage(
      "Give me a story for a dragon called called Atlantis in document",
    );
    await predictiveStateUpdates.getPredictiveResponse();
    await predictiveStateUpdates.getUserApproval();
    await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
    const dragonName =
      await predictiveStateUpdates.verifyAgentResponse("Atlantis");
    expect(dragonName).not.toBeNull();

    // Send update to change the dragon name
    await predictiveStateUpdates.sendMessage("Change dragon name to Lola");
    await page.waitForTimeout(2000);
    await predictiveStateUpdates.verifyHighlightedText();
    await predictiveStateUpdates.getUserRejection();
    await expect(predictiveStateUpdates.rejectedChangesResponse).toBeVisible();
    const dragonNameAfterRejection =
      await predictiveStateUpdates.verifyAgentResponse("Atlantis");
    expect(dragonNameAfterRejection).toBe(dragonName);
    expect(dragonNameAfterRejection).not.toBe("Lola");
  });
});
