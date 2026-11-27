import { test } from "../../test-isolation-helper";
import { GenerativeUIPage } from "../../featurePages/GenerativeUIPage";
import { GENERATIVE_UI_PROMPT } from "../../generative-ui-fixtures";

for (const transport of ["markdown", "tool"] as const) {
  test(`[Mastra Agent Local] Generative UI (${transport}) renders the A2UI surface from the injected guide`, async ({
    page,
  }) => {
    await page.goto(`/mastra-agent-local/feature/generative_ui_${transport}`);
    const genui = new GenerativeUIPage(page);
    await genui.sendMessage(GENERATIVE_UI_PROMPT);
    await genui.assertPlanPickerRendered();
    await genui.assertNoRenderErrors();
  });
}
