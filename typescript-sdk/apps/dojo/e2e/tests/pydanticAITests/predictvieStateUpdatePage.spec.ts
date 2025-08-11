import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/pydanticAIPages/PredictiveStateUpdatesPage";

test.describe("Predictive Status Updates Feature", () => {
  test("[PydanticAI] should interact with agent and approve asked changes", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      // Update URL to new domain
      await page.goto(
        "https://ag-ui-dojo-nine.vercel.app/pydantic-ai/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();
      await predictiveStateUpdates.sendMessage(
        "Give me a story for a dragon called Atlantis in document"
      );
      await waitForAIResponse(page);
      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.isVisible();
      const dragonName = await predictiveStateUpdates.verifyAgentResponse(
        "Atlantis"
      );
      expect(dragonName).not.toBeNull();

      // Send update to change the dragon name
      await predictiveStateUpdates.sendMessage("Change dragon name to Lola");
      await waitForAIResponse(page);
      await predictiveStateUpdates.verifyHighlightedText();
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.nth(1).isVisible();
      const dragonNameNew = await predictiveStateUpdates.verifyAgentResponse(
        "Lola"
      );
      expect(dragonNameNew).not.toBe(dragonName);
    });
  });

  test("[PydanticAI] should interact with agent and reject asked changes", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      // Update URL to new domain
      await page.goto(
        "https://ag-ui-dojo-nine.vercel.app/pydantic-ai/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();

      await predictiveStateUpdates.sendMessage(
        "Give me a story for a dragon called called Atlantis in document"
      );
      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.isVisible();
      const dragonName = await predictiveStateUpdates.verifyAgentResponse(
        "Atlantis"
      );
      expect(dragonName).not.toBeNull();

      // Send update to change the dragon name
      await predictiveStateUpdates.sendMessage("Change dragon name to Lola");
      await waitForAIResponse(page);
      await predictiveStateUpdates.verifyHighlightedText();
      await predictiveStateUpdates.getUserRejection();
      await predictiveStateUpdates.rejectedChangesResponse.isVisible();
      const dragonNameAfterRejection = await predictiveStateUpdates.verifyAgentResponse(
        "Atlantis"
      );
      expect(dragonNameAfterRejection).toBe(dragonName);
      expect(dragonNameAfterRejection).not.toBe("Lola");
    });
  });
});