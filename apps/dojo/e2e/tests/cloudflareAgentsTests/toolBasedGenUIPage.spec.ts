import { test, expect } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

// generate_haiku is the page's tool: the Worker hands it to the model as a
// client tool and the page renders the card from the streamed TOOL_CALL_*
// events.
const pageURL = "/cloudflare-agents/feature/tool_based_generative_ui";

test("[Cloudflare Agents] Haiku generation and display verification", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();
  await genAIAgent.generateHaiku('Generate Haiku for "I will always win"');
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});

test("[Cloudflare Agents] Haiku generation and UI consistency for two different prompts", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(page, pageURL);

  const genAIAgent = new ToolBaseGenUIPage(page);

  await expect(genAIAgent.haikuAgentIntro).toBeVisible();

  const prompt1 = 'Generate Haiku for "I will always win"';
  await genAIAgent.generateHaiku(prompt1);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);

  const afterFirst = await genAIAgent.snapshotHaiku(page);

  // The second haiku must be a new card with new lines, not the first one
  // replayed or its arguments appended to the first call.
  const prompt2 = 'Generate Haiku for "The moon shines bright"';
  await genAIAgent.generateHaiku(prompt2);
  await genAIAgent.checkLaterHaikuArrived(page, afterFirst);
  await genAIAgent.checkGeneratedHaiku();
  await genAIAgent.checkHaikuDisplay(page);
});
