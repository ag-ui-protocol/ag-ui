import {
  test,
  expect,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[LangGraph FastAPI] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/langgraph-fastapi/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });
    await chat.sendMessage("Hi, I am duaa");

    await chat.assertUserMessageVisible("Hi, I am duaa");
    await chat.assertAgentReplyVisible(/Hello|Hi|Hey|Greetings|nice to meet|welcome/i);
  });
});

test("[LangGraph FastAPI] Agentic Chat changes background on message and reset", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/langgraph-fastapi/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    const backgroundContainer = page.locator('[data-testid="background-container"]');
    const getBackground = () => backgroundContainer.evaluate(el => el.style.background);
    const initialBackground = await getBackground();

    // 1. Send message to change background to blue
    await chat.sendMessage("Hi change the background color to blue");
    await chat.assertUserMessageVisible(
      "Hi change the background color to blue"
    );

    await expect.poll(getBackground).not.toBe(initialBackground);
    const backgroundAfterBlue = await getBackground();

    // 2. Change to pink
    await chat.sendMessage("Hi change the background color to pink");
    await chat.assertUserMessageVisible(
      "Hi change the background color to pink"
    );

    await expect.poll(getBackground).not.toBe(backgroundAfterBlue);
    const backgroundAfterPink = await getBackground();
    // Verify it also differs from initial (not a reset)
    expect(backgroundAfterPink).not.toBe(initialBackground);
  });
});

test("[LangGraph FastAPI] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/langgraph-fastapi/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.click();

    await chat.sendMessage("Hey there");
    await chat.assertUserMessageVisible("Hey there");
    await chat.assertAgentReplyVisible(/how can I|help|assist|what can I do|what would you like/i);

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

// Test requires too many sequential LLM calls; consistently exceeds 60s timeout.
test.fixme("[LangGraph FastAPI] Agentic Chat regenerates a response", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/langgraph-fastapi/feature/agentic_chat");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    // Send first message and wait for response
    await chat.sendMessage("Hello agent");

    // Send second message asking for a joke
    await chat.sendMessage("tell me a joke");

    // Record the joke response text (index 2: greeting=0, hello reply=1, joke=2)
    const originalJoke = await chat.getAssistantMessageText(2);

    // Send another message so the joke is not the last message
    await chat.sendMessage("provide a random person's name");

    // Regenerate the joke response
    await chat.regenerateResponse(2);

    // Wait for the regeneration stream to complete
    await page.waitForFunction(
      () => document.querySelector('[data-copilot-running="false"]') !== null,
      null,
      { timeout: 15000 }
    );

    // Verify the regenerated response is valid (non-empty)
    const newJoke = await chat.getAssistantMessageText(2);
    expect(newJoke.length).toBeGreaterThan(0);
  });
});
