import {
  test,
  expect,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { sendChatMessage, awaitLLMResponseDone } from "../../utils/copilot-actions";

test("[Mastra] Agentic Chat sends and receives a greeting message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/mastra/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });
    await chat.sendMessage("Hi");

    await chat.assertUserMessageVisible("Hi");
    await chat.assertAgentReplyVisible(/Hello|Hi|hey/i);
  });
});

test("[Mastra] Agentic Chat provides weather information", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/mastra/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    // Ask for Islamabad weather — use sendChatMessage to avoid
    // sendAndAwaitResponse timeout when the weather tool call is slow
    await sendChatMessage(page, "What is the weather in Islamabad");
    await chat.assertUserMessageVisible("What is the weather in Islamabad");

    // The weather-info component renders deterministically; wait for it
    await chat.assertWeatherResponseStructure();
  });
});

test("[Mastra] Agentic Chat retains memory of previous questions", async ({
  page,
}) => {
  test.slow(); // Multi-step AI test with external weather API calls
  await retryOnAIFailure(async () => {
    await page.goto(
      "/mastra/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    // First question about weather — sendChatMessage avoids the
    // sendAndAwaitResponse timeout when the weather tool is slow
    await sendChatMessage(page, "What is the weather in Islamabad");
    await chat.assertUserMessageVisible("What is the weather in Islamabad");
    await chat.assertWeatherResponseStructure();

    // Ensure stream is done before sending next message
    await awaitLLMResponseDone(page);

    // Ask about the first question to test memory
    await chat.sendMessage("What was my first question");
    await chat.assertUserMessageVisible("What was my first question");

    // Check if the agent remembers the first question about weather
    await chat.assertAgentReplyVisible(/weather|Islamabad/i);
  });
});

test("[Mastra] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/mastra/feature/agentic_chat"
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