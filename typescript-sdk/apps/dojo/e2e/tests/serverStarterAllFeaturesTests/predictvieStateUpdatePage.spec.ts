import { test, expect, waitForAIResponse, retryOnAIFailure, } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/serverStarterAllFeaturesPages/PredictiveStateUpdatesPage";

test.describe("Predictive Status Updates Feature", () => {
  test("[Server Starter all features] should interact with agent and approve asked changes", async ({ page, }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      // Update URL to new domain
      await page.goto(
        "https://ag-ui-dojo-nine.vercel.app/server-starter-all-features/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();
      
      // Send initial message "Hi"
      await predictiveStateUpdates.sendMessage("Hi");
      await waitForAIResponse(page);
      
      // Get initial response with dog story
      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.isVisible();
      
      // Store the original content after first confirmation
      const originalContent = await predictiveStateUpdates.getResponseContent();
      expect(originalContent).not.toBeNull();

      // Send update to change the dog name
      await predictiveStateUpdates.sendMessage("Change the dog name");
      await waitForAIResponse(page);
      
      // Verify highlighted text (showing the change)
      await predictiveStateUpdates.verifyHighlightedText();
      
      // Approve the change
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.nth(1).isVisible();
      
      // Get the updated content after approval
      const updatedContent = await predictiveStateUpdates.getResponseContent();
      
      // Verify the content has changed
      expect(updatedContent).not.toBe(originalContent);
    });
  });

  test("[Server Starter all features] should interact with agent and reject asked changes", async ({ page, }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      // Update URL to new domain
      await page.goto(
        "https://ag-ui-dojo-nine.vercel.app/server-starter-all-features/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();
      
      // Send initial message "Hi"
      await predictiveStateUpdates.sendMessage("Hi");
      await waitForAIResponse(page);
      
      // Get initial response with dog story
      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.isVisible();
      
      // Store the original content after first confirmation
      const originalContent = await predictiveStateUpdates.getResponseContent();
      expect(originalContent).not.toBeNull();

      // Send update to change the dog name
      await predictiveStateUpdates.sendMessage("Change the dog name");
      await waitForAIResponse(page);
      
      // Verify highlighted text (showing the proposed change)
      await predictiveStateUpdates.verifyHighlightedText();
      
      // Reject the change
      await predictiveStateUpdates.getUserRejection();
      await predictiveStateUpdates.confirmedChangesResponse.nth(1).isVisible();
      
      // Verify the agent response prompt is visible (indicating rejection handled)
      await predictiveStateUpdates.agentResponsePrompt.isVisible();
      
      // Get the current content after rejection
      const currentContent = await predictiveStateUpdates.getResponseContent();
      
      // Verify the content hasn't changed after rejection
      expect(currentContent).toBe(originalContent);
    });
  });
});