import { toolBasedGenUIPageEventTrace } from "./toolBasedGenUIPage.event-trace";
import { test, expect } from "../../event-trace-test";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

const pageURL = "/aws-strands-typescript/feature/tool_based_generative_ui";

test("[StrandsTS] Haiku generation and display verification", async ({
  page,
  eventTrace,
}) => {
  await page.goto(pageURL, { waitUntil: "networkidle" });

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  await eventTrace.expectJourney(
    toolBasedGenUIPageEventTrace.haikuGenerationAndDisplayVerification,
    (events) => {
      const toolArgs = events.filter(
        (event) => event.type === "TOOL_CALL_ARGS",
      );
      expect(JSON.stringify(toolArgs)).toContain("勝利の道を");
    },
  );
});

test("[StrandsTS] Haiku generation and UI consistency for two different prompts", async ({
  page,
  eventTrace,
}) => {
  await page.goto(pageURL, { waitUntil: "networkidle" });

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  const prompt1 = 'Generate Haiku for "I will always win"';
  await genAIAgent.generateHaiku(prompt1);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  const afterFirst = await genAIAgent.snapshotHaiku(page);

  const prompt2 = 'Generate Haiku for "The moon shines bright"';
  await genAIAgent.generateHaiku(prompt2);
  await genAIAgent.checkLaterHaikuArrived(page, afterFirst);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  await eventTrace.expectJourney(
    toolBasedGenUIPageEventTrace.haikuGenerationAndUIConsistencyForTwoDifferentPrompts,
  );
});
