import { test, expect } from "./test";
import { PredictiveStateUpdatesPage } from "../../pages/langGraphFastAPIPages/PredictiveStateUpdatesPage";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

// `write_document` is a frontend tool whose argument streams into state.document
// (PredictState); the confirm dialog resolves the suspended call on the next run.
test.describe("Predictive State Updates Feature", () => {
  test("[GitHub Copilot SDK] streams the document and applies approved changes", async ({
    page,
  }) => {
    const predictive = new PredictiveStateUpdatesPage(page);
    await page.goto(`/${integrationId}/feature/predictive_state_updates`);
    await predictive.openChat();

    await predictive.sendMessage("Give me a story for a dragon called Atlantis in document");
    await predictive.getPredictiveResponse();
    await predictive.getUserApproval();
    await expect(predictive.confirmedChangesResponse).toBeVisible();
    const dragonName = await predictive.verifyAgentResponse("Atlantis");
    expect(dragonName).not.toBeNull();

    await predictive.sendMessage("Change dragon name to Lola");
    await predictive.verifyHighlightedText();
    await predictive.getUserApproval();
    await expect(predictive.confirmedChangesResponse).toBeVisible();
    expect(await predictive.verifyAgentResponse("Lola")).not.toBe(dragonName);
  });

  test("[GitHub Copilot SDK] keeps the document when changes are rejected", async ({ page }) => {
    const predictive = new PredictiveStateUpdatesPage(page);
    await page.goto(`/${integrationId}/feature/predictive_state_updates`);
    await predictive.openChat();

    await predictive.sendMessage("Give me a story for a dragon called Atlantis in document");
    await predictive.getPredictiveResponse();
    await predictive.getUserApproval();
    await expect(predictive.confirmedChangesResponse).toBeVisible();
    const dragonName = await predictive.verifyAgentResponse("Atlantis");

    await predictive.sendMessage("Change dragon name to Lola");
    await predictive.verifyHighlightedText();
    await predictive.getUserRejection();
    await expect(predictive.rejectedChangesResponse).toBeVisible();
    expect(await predictive.verifyAgentResponse("Atlantis")).toBe(dragonName);
  });
});
