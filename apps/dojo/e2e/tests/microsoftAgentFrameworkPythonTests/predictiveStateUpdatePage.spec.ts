import { test, expect } from "../../test-isolation-helper";
import { PredictiveStateUpdatesPage } from "../../pages/langGraphPages/PredictiveStateUpdatesPage";

test("[MS Agent Framework Python] resumes an approved predictive-state interrupt", async ({
  page,
}) => {
  const predictiveState = new PredictiveStateUpdatesPage(page);

  await page.goto(
    "/microsoft-agent-framework-python/feature/predictive_state_updates",
  );
  await predictiveState.openChat();
  await predictiveState.sendMessage(
    "Give me a story for a dragon called Atlantis in document",
  );

  await predictiveState.getPredictiveResponse();
  await predictiveState.getUserApproval();
  await expect(
    page.getByText("Done! I've completed that for you."),
  ).toBeVisible();
  expect(await predictiveState.verifyAgentResponse("Atlantis")).not.toBeNull();
});
