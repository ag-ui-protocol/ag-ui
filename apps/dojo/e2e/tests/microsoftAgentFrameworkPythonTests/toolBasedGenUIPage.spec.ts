import { test, expect } from "../../test-isolation-helper";
import { ToolBaseGenUIPage } from "../../featurePages/ToolBaseGenUIPage";

test("[MS Agent Framework Python] executes a client-rendered tool with a matching server declaration", async ({
  page,
}) => {
  await page.goto(
    "/microsoft-agent-framework-python/feature/tool_based_generative_ui",
  );

  const generativeUI = new ToolBaseGenUIPage(page);
  await expect(generativeUI.haikuAgentIntro).toBeVisible();
  await generativeUI.generateHaiku('Generate Haiku for "I will always win"');
  await expect(page.getByText("勝利の道を").first()).toBeVisible();
  await generativeUI.checkGeneratedHaiku();
  await generativeUI.checkHaikuDisplay(page);
});
