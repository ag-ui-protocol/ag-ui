import {
  test,
  expect,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/adkMiddlewarePages/PredictiveStateUpdatesPage";

// TODO: Re-enable when CI environment is configured for this demo.
// The demo falls back to Gemini 2.5 Flash without Vertex AI credentials, so
// these tests will pass even without streaming function call arguments enabled.
// Full streaming requires: GOOGLE_GENAI_USE_VERTEXAI=TRUE, GOOGLE_CLOUD_PROJECT,
// GOOGLE_CLOUD_LOCATION=global (selects Gemini 3 Pro Preview with stream_function_call_arguments).
test.describe.skip("Predictive State Updates Feature", () => {
  test("[ADK Middleware] should interact with agent and approve asked changes", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      // Update URL to new domain
      await page.goto(
        "/adk-middleware/feature/predictive_state_updates"
      );

      await predictiveStateUpdates.openChat();
      await predictiveStateUpdates.sendMessage(
        "Give me a story for a dragon called Atlantis in document"
      );
      await page.waitForTimeout(2000);
      await predictiveStateUpdates.getPredictiveResponse();
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.isVisible();
      const dragonName = await predictiveStateUpdates.verifyAgentResponse(
        "Atlantis"
      );
      expect(dragonName).not.toBeNull();

      // Send update to change the dragon name
      await predictiveStateUpdates.sendMessage("Change dragon name to Lola");
      await page.waitForTimeout(2000);
      await predictiveStateUpdates.verifyHighlightedText();
      await predictiveStateUpdates.getUserApproval();
      await predictiveStateUpdates.confirmedChangesResponse.nth(1).isVisible();
      const dragonNameNew = await predictiveStateUpdates.verifyAgentResponse(
        "Lola"
      );
      expect(dragonNameNew).not.toBe(dragonName);
    });
  });

  test("[ADK Middleware] should interact with agent and reject asked changes", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

      // Update URL to new domain
      await page.goto(
        "/adk-middleware/feature/predictive_state_updates"
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
      await page.waitForTimeout(2000);
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
