import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

test.describe("Interrupt (Suspend/Resume) Feature", () => {
  test("[CLI Agent Orchestrator] suspends a tool and surfaces the interrupt picker", async ({
    page,
  }) => {
    await page.goto("/cli-agent-orchestrator/feature/interrupt");
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await CopilotSelectors.chatTextarea(page).fill(
      "Book an intro call with the sales team to discuss pricing.",
    );
    await CopilotSelectors.sendButton(page).click();

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByRole("button").first()).toBeVisible();
  });

  test("[CLI Agent Orchestrator] resolving the picker advances the run", async ({
    page,
  }) => {
    await page.goto("/cli-agent-orchestrator/feature/interrupt");
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await CopilotSelectors.chatTextarea(page).fill(
      "Book an intro call with the sales team to discuss pricing.",
    );
    await CopilotSelectors.sendButton(page).click();

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    await picker.getByRole("button").first().click();
    await expect(picker).toBeHidden({ timeout: 30_000 });
  });
});
