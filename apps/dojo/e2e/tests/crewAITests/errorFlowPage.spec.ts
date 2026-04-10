import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { sendChatMessage } from "../../utils/copilot-actions";

test("[CrewAI] Error flow emits RunErrorEvent on backend exception", async ({
  page,
}) => {
  await page.goto("/crewai/feature/error_flow");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  // Send manually — sendMessage calls awaitLLMResponseDone which depends on
  // data-copilot-running transitioning to false. With the RunErrorEvent fix
  // (CopilotKit/CopilotKit#3749), this should now work, but we use
  // sendChatMessage + explicit wait as a safer pattern for error scenarios.
  await sendChatMessage(page, "trigger error");
  await chat.assertUserMessageVisible("trigger error");

  // Wait for CopilotKit to process the error — RunErrorEvent should now
  // transition data-copilot-running to false (fixed in @copilotkit/core 1.55.2)
  await page.waitForFunction(
    () => {
      const el = document.querySelector("[data-copilot-running]");
      return el === null || el.getAttribute("data-copilot-running") === "false";
    },
    null,
    { timeout: 10_000 },
  );

  // Verify no successful assistant response beyond the greeting
  const messageCount = await chat.agentMessage.count();
  expect(messageCount).toBeLessThanOrEqual(1);
});
