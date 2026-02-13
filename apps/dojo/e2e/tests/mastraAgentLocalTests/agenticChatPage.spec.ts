import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[MastraAgentLocal] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/mastra-agent-local/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible", timeout: 15000 });
    await chat.sendMessage("Hi, I am duaa");

    await waitForAIResponse(page);
    await chat.assertUserMessageVisible("Hi, I am duaa");
    // The agent should reply with *something* — don't assert specific wording
    await expect(chat.agentMessage.last()).toBeVisible({ timeout: 15000 });
  });
});

test("[MastraAgentLocal] Agentic Chat changes background on message and reset", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/mastra-agent-local/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible", timeout: 15000 });

    // Store initial background color
    const backgroundContainer = page.locator('[data-testid="background-container"]');
    const initialBackground = await backgroundContainer.evaluate(el => getComputedStyle(el).backgroundColor);
    console.log("Initial background color:", initialBackground);

    // 1. Send message to change background to blue
    await chat.sendMessage("Change the background color to blue. You must change it.");
    await chat.assertUserMessageVisible(
      /change the background color to blue/i
    );
    await waitForAIResponse(page);

    // Wait for the background to change from its initial value.
    // Use a longer timeout since the agent needs to process and emit a state update.
    await expect(backgroundContainer).not.toHaveCSS('background-color', initialBackground, { timeout: 30000 });
    const backgroundAfterBlue = await backgroundContainer.evaluate(el => getComputedStyle(el).backgroundColor);
    console.log("Background after blue request:", backgroundAfterBlue);
    // Just verify it changed — don't assert the exact color since LLM might pick a shade
    expect(backgroundAfterBlue).not.toBe(initialBackground);

    // 2. Change to pink
    await chat.sendMessage("Now change the background color to pink. You must change it.");
    await chat.assertUserMessageVisible(
      /change the background color to pink/i
    );
    await waitForAIResponse(page);

    await expect(backgroundContainer).not.toHaveCSS('background-color', backgroundAfterBlue, { timeout: 30000 });
    const backgroundAfterPink = await backgroundContainer.evaluate(el => getComputedStyle(el).backgroundColor);
    console.log("Background after pink request:", backgroundAfterPink);
    expect(backgroundAfterPink).not.toBe(backgroundAfterBlue);
  });
});

test("[MastraAgentLocal] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/mastra-agent-local/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible", timeout: 15000 });

    // Send a message with a distinctive fact
    const favFruit = "Mango";
    await chat.sendMessage(`My favorite fruit is ${favFruit}`);
    await chat.assertUserMessageVisible(`My favorite fruit is ${favFruit}`);
    await waitForAIResponse(page);
    // Just verify the agent responded, don't require specific wording
    await expect(chat.agentMessage.last()).toBeVisible({ timeout: 15000 });

    // Add another distinctive fact
    await chat.sendMessage("and I love listening to Kaavish");
    await chat.assertUserMessageVisible("and I love listening to Kaavish");
    await waitForAIResponse(page);
    await expect(chat.agentMessage.last()).toBeVisible({ timeout: 15000 });

    // Now ask the agent to recall the fruit — this tests memory
    await chat.sendMessage("Can you remind me what my favorite fruit is?");
    await chat.assertUserMessageVisible(
      "Can you remind me what my favorite fruit is?"
    );
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));
  });
});
