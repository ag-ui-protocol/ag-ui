import { test, expect } from "../../event-trace-test";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";
import { toolBasedGenUIPageEventTrace as defaultEventTrace } from "./toolBasedGenUIPage.event-trace";
import { toolBasedGenUIPageEventTrace as v2EventTrace } from "./v2/toolBasedGenUIPage.event-trace";
const toolBasedGenUIPageEventTrace =
  process.env.LANGGRAPH_TRACE_REFERENCE === "v2"
    ? v2EventTrace
    : defaultEventTrace;

const pageURL = "/langgraph-typescript/feature/tool_based_generative_ui";

test("[LangGraph] Haiku generation and display verification", async ({
  page,
  eventTrace,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
  await eventTrace.expectJourney(
    toolBasedGenUIPageEventTrace.haikuGenerationAndDisplayVerification,
  );
});

test("[LangGraph] Haiku generation and UI consistency for two different prompts", async ({
  page,
  eventTrace,
}) => {
  await page.goto(pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  const prompt1 = 'Generate Haiku for "I will always win"';
  const firstRun = genAIAgent.captureRuntimeSSE(
    "langgraph-typescript",
    "I will always win",
  );
  await genAIAgent.generateHaiku(prompt1);
  await firstRun;
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  const prompt2 = 'Generate Haiku for "The moon shines bright"';
  const previous = await genAIAgent.snapshotHaiku(page);
  const secondRun = genAIAgent.captureRuntimeSSE(
    "langgraph-typescript",
    "The moon shines bright",
  );
  await genAIAgent.generateHaiku(prompt2);
  await secondRun;
  await genAIAgent.checkLaterHaikuArrived(page, previous);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
  await eventTrace.expectJourney(
    toolBasedGenUIPageEventTrace.haikuGenerationAndUIConsistencyForTwoDifferentPrompts,
  );
});
