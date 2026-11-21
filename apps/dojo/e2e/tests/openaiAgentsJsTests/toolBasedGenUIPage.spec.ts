import { expect, test } from "../../test-isolation-helper";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

test("[OpenAI Agents JS] Tool Based Generative UI displays a haiku", async ({
  page,
}) => {
  await page.goto("/openai-agents-js/feature/tool_based_generative_ui");
  const generativeUi = new ToolBaseGenUIPage(page);

  await expect(generativeUi.haikuAgentIntro).toBeVisible();
  await generativeUi.generateHaiku(
    'Generate Haiku for "The moon shines bright"',
  );
  await generativeUi.checkGeneratedHaiku();
  await generativeUi.checkHaikuDisplay(page);

  const firstHaiku = await generativeUi.snapshotHaiku(page);
  await generativeUi.generateHaiku('Generate Haiku for "I will always win"');
  await generativeUi.checkLaterHaikuArrived(page, firstHaiku);
});
