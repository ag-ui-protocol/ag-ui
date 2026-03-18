import { test, expect } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/serverStarterAllFeaturesPages/PredictiveStateUpdatesPage";

test.describe("Predictive Status Updates Feature", () => {
  // The server-starter-all backend is a mock that streams write_document_local
  // + confirm_changes tool calls. The confirm_changes HiTL modal works, but the
  // predictive state mechanism (PredictState custom event -> editor content) does
  // not populate the TipTap editor in the current framework version. These tests
  // verify the HiTL confirm/reject flow works end-to-end.

  test("[Server Starter all features] should interact with agent and approve asked changes", async ({
    page,
  }) => {
    const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

    await page.goto(
      "/server-starter-all-features/feature/predictive_state_updates",
    );

    await predictiveStateUpdates.openChat();

    await predictiveStateUpdates.sendMessage("Write a story");

    // The mock backend sends confirm_changes tool call -> HiTL modal appears
    await predictiveStateUpdates.getPredictiveResponse();
    await predictiveStateUpdates.getUserApproval();

    // After approval the agent responds with a confirmation message
    await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();

    // Send a follow-up message - triggers another round of tool calls
    await predictiveStateUpdates.sendMessage("Update the story");

    await predictiveStateUpdates.verifyHighlightedText();
    await predictiveStateUpdates.getUserApproval();
    await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();
  });

  test("[Server Starter all features] should interact with agent and reject asked changes", async ({
    page,
  }) => {
    const predictiveStateUpdates = new PredictiveStateUpdatesPage(page);

    await page.goto(
      "/server-starter-all-features/feature/predictive_state_updates",
    );

    await predictiveStateUpdates.openChat();

    await predictiveStateUpdates.sendMessage("Write a story");

    // First round: approve to establish baseline
    await predictiveStateUpdates.getPredictiveResponse();
    await predictiveStateUpdates.getUserApproval();
    await expect(predictiveStateUpdates.confirmedChangesResponse).toBeVisible();

    // Second round: reject the changes
    await predictiveStateUpdates.sendMessage("Update the story");

    await predictiveStateUpdates.verifyHighlightedText();
    await predictiveStateUpdates.getUserRejection();
    await expect(predictiveStateUpdates.rejectedChangesResponse).toBeVisible();
  });
});
