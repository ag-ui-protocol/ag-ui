import { test, expect } from "../../test-isolation-helper";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

test.describe("Open Generative UI Feature", () => {
  test("[LangGraph FastAPI] Open Gen UI sends and receives a message", async ({
    page,
  }) => {
    await page.goto("/langgraph-fastapi/feature/open_gen_ui");

    await openChat(page);
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await sendChatMessage(page, "Hi");
    await awaitLLMResponseDone(page);

    // Verify the user message is visible
    await expect(
      CopilotSelectors.userMessages(page).getByText("Hi"),
    ).toBeVisible();

    // Verify the agent replied (catch-all fixture returns generic text)
    const assistantMsg = CopilotSelectors.assistantMessages(page).last();
    await expect(assistantMsg).toBeVisible();
    await expect(assistantMsg).not.toBeEmpty();
  });

  test("[LangGraph FastAPI] Open Gen UI renders sandboxed UI on tool call", async ({
    page,
  }) => {
    await page.goto("/langgraph-fastapi/feature/open_gen_ui");

    await openChat(page);
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await sendChatMessage(page, "Please build a red button that says hello");
    await awaitLLMResponseDone(page);

    // Verify user message is visible
    await expect(
      CopilotSelectors.userMessages(page).getByText(
        "Please build a red button that says hello",
      ),
    ).toBeVisible();

    // The generateSandboxedUi tool call should produce a sandboxed iframe
    // rendered via the OpenGenerativeUIMiddleware activity events.
    // The websandbox library creates an iframe inside the chat message area.
    const iframe = page.locator(
      '[data-testid="copilot-message-list"] iframe',
    );
    await expect(iframe).toBeVisible({ timeout: 15_000 });
  });
});
