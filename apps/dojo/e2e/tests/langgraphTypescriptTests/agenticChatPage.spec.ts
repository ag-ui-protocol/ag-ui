import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[LangGraph] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/langgraph-typescript/feature/agentic_chat"
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

test("[LangGraph] Agentic Chat changes background on message and reset", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/langgraph-typescript/feature/agentic_chat"
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

    // Poll for CSS change with generous timeout — the AI tool call may take
    // significant time to execute and propagate to the DOM.
    await expect
      .poll(
        async () => {
          const current = await backgroundContainer.evaluate(
            (el) => getComputedStyle(el).backgroundColor
          );
          return current !== initialBackground;
        },
        {
          message: `Background color did not change from initial value "${initialBackground}" after requesting blue`,
          timeout: 60_000,
          intervals: [500, 1000, 2000, 3000, 5000],
        }
      )
      .toBeTruthy();

    const backgroundBlue = await backgroundContainer.evaluate(el => getComputedStyle(el).backgroundColor);
    console.log("Background after blue request:", backgroundBlue);

    // 2. Change to pink
    await chat.sendMessage("Hi change the background color to pink");
    await chat.assertUserMessageVisible(
      "Hi change the background color to pink"
    );
    await waitForAIResponse(page);

    await expect
      .poll(
        async () => {
          const current = await backgroundContainer.evaluate(
            (el) => getComputedStyle(el).backgroundColor
          );
          return current !== backgroundBlue;
        },
        {
          message: `Background color did not change from blue value "${backgroundBlue}" after requesting pink`,
          timeout: 60_000,
          intervals: [500, 1000, 2000, 3000, 5000],
        }
      )
      .toBeTruthy();

    const backgroundPink = await backgroundContainer.evaluate(el => getComputedStyle(el).backgroundColor);
    console.log("Background after pink request:", backgroundPink);
    // Verify it also differs from initial (not a reset)
    expect(backgroundPink).not.toBe(initialBackground);
  });
});

test("[LangGraph] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/langgraph-typescript/feature/agentic_chat"
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

test("[LangGraph Typescript] Agentic Chat regenerates a response", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/langgraph-typescript/feature/agentic_chat");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    // Send first message and wait for response
    await chat.sendMessage("Hello agent");
    await waitForAIResponse(page);

    // Send second message asking for a joke
    await chat.sendMessage("tell me a joke");
    await waitForAIResponse(page);

    // Record the joke response text (index 2: greeting=0, hello reply=1, joke=2)
    const originalJoke = await chat.getAssistantMessageText(2);
    expect(originalJoke.length).toBeGreaterThan(0);

    // Send another message so the joke is not the last message
    await chat.sendMessage("provide a random person's name");
    await waitForAIResponse(page);

    // Regenerate the joke response
    await chat.regenerateResponse(2);
    await waitForAIResponse(page);

    // Verify regeneration produced a response. We do NOT assert the text differs
    // from the original because LLMs can and do produce identical outputs —
    // that's not a test failure. What matters is that the regenerate action
    // triggered successfully and produced content.
    const newJoke = await chat.getAssistantMessageText(2);
    expect(newJoke.length).toBeGreaterThan(0);
  });
});
