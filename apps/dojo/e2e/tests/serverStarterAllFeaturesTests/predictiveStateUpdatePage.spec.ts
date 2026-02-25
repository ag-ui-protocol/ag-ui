import { test, expect, retryOnAIFailure, } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/serverStarterAllFeaturesPages/PredictiveStateUpdatesPage";

test.describe("Predictive Status Updates Feature", () => {
  // Agent does not write content to the document editor for this integration.
  test.fixme("[Server Starter all features] should interact with agent and approve asked changes", async ({ page, }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      await page.goto(
        "/server-starter-all-features/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.sendMessage(
        "Give me a story for a dragon called Atlantis in document"
      );
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserApproval();
      await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
      const dragonName = await predictiveStateUpdates.verifyAgentResponse(
        "Atlantis"
      );
      expect(dragonName).not.toBeNull();

      await page.waitForTimeout(3000);

      await predictiveStateUpdates.sendMessage("Change dragon name to Lola");
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.verifyHighlightedText();

      await predictiveStateUpdates.getUserApproval();
      await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
      const dragonNameNew = await predictiveStateUpdates.verifyAgentResponse(
        "Lola"
      );
      expect(dragonNameNew).not.toBe(dragonName);
    });
  });

  // Skipped while the above test is fixme - the feature is not supported by this integration.
  test.skip("[Server Starter all features] should interact with agent and reject asked changes", async ({ page, }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      await page.goto(
        "/server-starter-all-features/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.sendMessage(
        "Give me a story for a dragon called Atlantis in document"
      );
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserApproval();
      await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
      const dragonName = await predictiveStateUpdates.verifyAgentResponse(
        "Atlantis"
      );
      expect(dragonName).not.toBeNull();

      await page.waitForTimeout(3000);

      await predictiveStateUpdates.sendMessage("Change dragon name to Lola");
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.verifyHighlightedText();

      await predictiveStateUpdates.getUserRejection();
      await expect(predictiveStateUpdates.rejectedChangesResponse).toBeVisible();
      const dragonNameAfterRejection = await predictiveStateUpdates.verifyAgentResponse(
        "Atlantis"
      );
      expect(dragonNameAfterRejection).toBe(dragonName);
      expect(dragonNameAfterRejection).not.toBe("Lola");
    });
  });
});