import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/langGraphPages/PredictiveStateUpdatesPage";

test.describe("Predictive Status Updates Feature", () => {
  test("[LangGraph] should interact with agent and approve asked changes", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      // Update URL to new domain
      await page.goto(
        "https://ag-ui-dojo-nine.vercel.app/langgraph/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();

      await predictiveStateUpdates.sendMessage(
        "Give me a story for a dragon called Atlantis"
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

  test("[LangGraph] should interact with agent and reject asked changes", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      // Update URL to new domain
      await page.goto(
        "https://ag-ui-dojo-nine.vercel.app/langgraph/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();

      await predictiveStateUpdates.sendMessage(
        "Give me a story for a dragon called called Atlantis"
      );
      await waitForAIResponse(page);
      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserRejection();
      await predictiveStateUpdates.confirmedChangesResponse.isVisible();
      await predictiveStateUpdates.agentResponsePrompt.isVisible();
    });
  });
});