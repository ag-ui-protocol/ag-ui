import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { sendChatMessage } from "../../utils/copilot-actions";

// RunErrorEvent does not transition data-copilot-running to false in the
// CopilotKit frontend. When the backend raises before any LLM call, the SSE
// stream emits RunErrorEvent and closes, but CopilotKit never sets
// data-copilot-running="false". This causes both sendMessage (via
// awaitLLMResponseDone) and manual waitForFunction to hang/timeout.
// This is a CopilotKit frontend bug — RunErrorEvent should terminate the
// running state so the UI doesn't show an infinite spinner.
test.fixme(
  "[CrewAI] Error flow emits RunErrorEvent on backend exception",
  async ({ page }) => {
    await page.goto("/crewai/feature/error_flow");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await expect(chat.agentGreeting).toBeVisible();

    await sendChatMessage(page, "trigger error");
    await chat.assertUserMessageVisible("trigger error");

    // Wait for CopilotKit to process the error
    await page.waitForFunction(
      () => {
        const el = document.querySelector("[data-copilot-running]");
        return (
          el === null || el.getAttribute("data-copilot-running") === "false"
        );
      },
      null,
      { timeout: 10_000 },
    );

    // Verify no successful assistant response beyond the greeting
    const messageCount = await chat.agentMessage.count();
    expect(messageCount).toBeLessThanOrEqual(1);
  },
);
