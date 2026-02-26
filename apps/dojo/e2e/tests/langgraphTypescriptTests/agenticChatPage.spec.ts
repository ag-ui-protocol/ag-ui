import {
  test,
  expect,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { sendChatMessage, awaitLLMResponseDone } from "../../utils/copilot-actions";

test("[LangGraph] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/langgraph-typescript/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });
    await chat.sendMessage("Hi, I am duaa");

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

    const backgroundContainer = page.locator('[data-testid="background-container"]');
    const getBackground = () => backgroundContainer.evaluate(el => el.style.background);
    const initialBackground = await getBackground();

    // Use sendChatMessage to avoid sendAndAwaitResponse timeout;
    // expect.poll handles waiting for the background to change.
    await sendChatMessage(page, "Hi change the background color to blue");
    await chat.assertUserMessageVisible(
      "Hi change the background color to blue"
    );

    await expect.poll(getBackground).not.toBe(initialBackground);
    const backgroundAfterBlue = await getBackground();

    // Ensure first response is done before sending the next
    await awaitLLMResponseDone(page);

    await sendChatMessage(page, "Hi change the background color to pink");
    await chat.assertUserMessageVisible(
      "Hi change the background color to pink"
    );

    await expect.poll(getBackground).not.toBe(backgroundAfterBlue);
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
    await chat.assertAgentReplyVisible(/how can I assist you/i);

    const favFruit = "Mango";
    await chat.sendMessage(`My favorite fruit is ${favFruit}`);
    await chat.assertUserMessageVisible(`My favorite fruit is ${favFruit}`);
    await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));

    await chat.sendMessage("and I love listening to Kaavish");
    await chat.assertUserMessageVisible("and I love listening to Kaavish");
    await chat.assertAgentReplyVisible(/Kaavish/i);

    await chat.sendMessage("tell me an interesting fact about Moon");
    await chat.assertUserMessageVisible(
      "tell me an interesting fact about Moon"
    );
    await chat.assertAgentReplyVisible(/Moon/i);

    await chat.sendMessage("Can you remind me what my favorite fruit is?");
    await chat.assertUserMessageVisible(
      "Can you remind me what my favorite fruit is?"
    );
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

    // Use sendChatMessage + awaitLLMResponseDone to save time budget
    // vs sendAndAwaitResponse (avoids double-waiting on assistant message count).
    // greeting=0, joke reply=1, filler reply=2
    await sendChatMessage(page, "tell me a joke");
    await awaitLLMResponseDone(page);

    const originalJoke = await chat.getAssistantMessageText(1);

    // Send a filler so the joke is not the last message
    await sendChatMessage(page, "say hello");
    await awaitLLMResponseDone(page);

    // Regenerate the joke response (index 1)
    await chat.regenerateResponse(1);

    await page.waitForFunction(
      () => document.querySelector('[data-copilot-running="false"]') !== null,
      null,
      { timeout: 15000 }
    );

    const newJoke = await chat.getAssistantMessageText(1);
    expect(newJoke.length).toBeGreaterThan(0);
  });
});
