import { test, expect } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/langGraphFastAPIPages/PredictiveStateUpdatesPage";

test.describe("Predictive Status Updates Feature", () => {
  test("[LangGraph FastAPI] should interact with agent and approve asked changes", async ({
    page,
  }) => {
    const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

    await page.goto("/langgraph-fastapi/feature/predictive_state_updates");

    await predictiveStateUpdates.openChat();

    await predictiveStateUpdates.sendMessage(
      "Give me a story for a dragon called Atlantis in document",
    );

    await predictiveStateUpdates.getPredictiveResponse();
    await predictiveStateUpdates.getUserApproval();
    await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
    const dragonName =
      await predictiveStateUpdates.verifyAgentResponse("Atlantis");
    expect(dragonName).not.toBeNull();

    await predictiveStateUpdates.sendMessage("Change dragon name to Lola");

    await predictiveStateUpdates.verifyHighlightedText();
    await predictiveStateUpdates.getUserApproval();
    await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
    const dragonNameNew =
      await predictiveStateUpdates.verifyAgentResponse("Lola");
    expect(dragonNameNew).not.toBe(dragonName);
  });

  test("[LangGraph FastAPI] should interact with agent and reject asked changes", async ({
    page,
  }) => {
    const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

    await page.goto("/langgraph-fastapi/feature/predictive_state_updates");

    await predictiveStateUpdates.openChat();

    await predictiveStateUpdates.sendMessage(
      "Give me a story for a dragon called Atlantis in document",
    );

    await predictiveStateUpdates.getPredictiveResponse();
    await predictiveStateUpdates.getUserApproval();
    await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
    const dragonName =
      await predictiveStateUpdates.verifyAgentResponse("Atlantis");
    expect(dragonName).not.toBeNull();

    await predictiveStateUpdates.sendMessage("Change dragon name to Lola");

    await predictiveStateUpdates.verifyHighlightedText();
    await predictiveStateUpdates.getUserRejection();
    await expect(predictiveStateUpdates.rejectedChangesResponse).toBeVisible();
    const dragonNameAfterRejection =
      await predictiveStateUpdates.verifyAgentResponse("Atlantis");
    expect(dragonNameAfterRejection).toBe(dragonName);
    expect(dragonNameAfterRejection).not.toBe("Lola");
  });
});
