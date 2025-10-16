import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[CrewAI] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/crewai/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.isVisible;
    await chat.sendMessage("Hi, I am duaa");

    await waitForAIResponse(page);
    await chat.assertUserMessageVisible("Hi, I am duaa");
    await chat.assertAgentReplyVisible(/Hello/i);
  });
});

test("[CrewAI] Agentic Chat changes background on message and reset", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/crewai/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    // Store initial background color
    const backgroundContainer = page.locator('[data-testid="background-container"]')
    const initialBackground = await backgroundContainer.evaluate(el => getComputedStyle(el).backgroundColor);
    console.log("Initial background color:", initialBackground);

    // 1. Send message to change background to blue
    await chat.sendMessage("Hi change the background color to blue");
    await chat.assertUserMessageVisible(
      "Hi change the background color to blue"
    );
    await waitForAIResponse(page);

    await expect(backgroundContainer).not.toHaveCSS('background-color', initialBackground, { timeout: 7000 });
    const backgroundBlue = await backgroundContainer.evaluate(el => getComputedStyle(el).backgroundColor);
    // Check if background is blue (string color name or contains blue)
    expect(backgroundBlue.toLowerCase()).toMatch(/blue|rgb\(.*,.*,.*\)|#[0-9a-f]{6}/);

    // 2. Change to pink
    await chat.sendMessage("Hi change the background color to pink");
    await chat.assertUserMessageVisible(
      "Hi change the background color to pink"
    );
    await waitForAIResponse(page);

    await expect(backgroundContainer).not.toHaveCSS('background-color', backgroundBlue, { timeout: 7000 });
    const backgroundPink = await backgroundContainer.evaluate(el => getComputedStyle(el).backgroundColor);
    // Check if background is pink (string color name or contains pink)
    expect(backgroundPink.toLowerCase()).toMatch(/pink|rgb\(.*,.*,.*\)|#[0-9a-f]{6}/);
  });
});

test("[CrewAI] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/crewai/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.click();

    await chat.sendMessage("Hey there");
    await chat.assertUserMessageVisible("Hey there");
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/how can I assist you/i);

    const favFruit = "Mango";
    await chat.sendMessage(`My favorite fruit is ${favFruit}`);
    await chat.assertUserMessageVisible(`My favorite fruit is ${favFruit}`);
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));

    await chat.sendMessage("and I love listening to Kaavish");
    await chat.assertUserMessageVisible("and I love listening to Kaavish");
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/Kaavish/i);

    await chat.sendMessage("tell me an interesting fact about Moon");
    await chat.assertUserMessageVisible(
      "tell me an interesting fact about Moon"
    );
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/Moon/i);

    await chat.sendMessage("Can you remind me what my favorite fruit is?");
    await chat.assertUserMessageVisible(
      "Can you remind me what my favorite fruit is?"
    );
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));
  });
});
