import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

const hasDifyEnv = Boolean(process.env.DIFY_API_KEY);
test.skip(!hasDifyEnv, "DIFY_API_KEY not set");

test("[Dify] Agentic Chat sends and receives a message", async ({ page }) => {
  await retryOnAIFailure(async () => {
    await page.goto("/dify/feature/agentic_chat");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });
    await chat.sendMessage("Hey there");
    await chat.assertUserMessageVisible("Hey there");
    await waitForAIResponse(page);
    await expect(chat.agentMessage.last()).toBeVisible({ timeout: 20000 });
  });
});

test("[Dify] Agentic Chat changes background on request", async ({ page }) => {
  await retryOnAIFailure(async () => {
    await page.goto("/dify/feature/agentic_chat");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    await chat.sendMessage("Change the background to a blue gradient");
    await chat.assertUserMessageVisible(
      "Change the background to a blue gradient",
    );
    await waitForAIResponse(page);
    await expect(chat.agentMessage.last()).toBeVisible({ timeout: 20000 });
  });
});
