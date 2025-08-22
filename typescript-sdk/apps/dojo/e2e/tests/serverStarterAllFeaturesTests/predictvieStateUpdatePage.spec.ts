import { test, expect, retryOnAIFailure, } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/serverStarterAllFeaturesPages/PredictiveStateUpdatesPage";

test.describe("Predictive Status Updates Feature", () => {
  test("[Server Starter all features] should interact with agent and approve asked changes", async ({ page, }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      await page.goto(
        "/server-starter-all-features/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.sendMessage("Hi");
      await page.waitForTimeout(2000);
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.isVisible();

      const originalContent = await predictiveStateUpdates.getResponseContent();
      expect(originalContent).not.toBeNull();

      await page.waitForTimeout(3000);

      await predictiveStateUpdates.sendMessage("Change the dog name");
      await page.waitForTimeout(2000);
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.verifyHighlightedText();

      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.isVisible();

      const updatedContent = await predictiveStateUpdates.getResponseContent();

      expect(updatedContent).not.toBe(originalContent);
    });
  });

  test("[Server Starter all features] should interact with agent and reject asked changes", async ({ page, }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      await page.goto(
        "/server-starter-all-features/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.sendMessage("Hi");
      await page.waitForTimeout(2000);
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.isVisible();

      const originalContent = await predictiveStateUpdates.getResponseContent();
      expect(originalContent).not.toBeNull();

      await page.waitForTimeout(3000);

      await predictiveStateUpdates.sendMessage("Change the dog name");
      await page.waitForTimeout(2000);
      await page.waitForTimeout(2000);

      await predictiveStateUpdates.verifyHighlightedText();

      await predictiveStateUpdates.getUserRejection();
      await predictiveStateUpdates.rejectedChangesResponse.isVisible();

      const currentContent = await predictiveStateUpdates.getResponseContent();

      expect(currentContent).toBe(originalContent);
    });
  });
});