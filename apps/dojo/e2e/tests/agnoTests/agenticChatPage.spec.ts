import {
  test,
  expect,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

const appleAsk = "What is the current stock price of AAPL? Please respond in the format of 'The current stock price of Apple Inc. (AAPL) is {{price}}'"

test("[Agno] Agentic Chat sends and receives a greeting message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/agno/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await expect(chat.agentGreeting).toBeVisible();
    await chat.sendMessage("Hi");

    await chat.assertUserMessageVisible("Hi");
    await chat.assertAgentReplyVisible(/Hello|Hi|hey/i);
  });
});

test("[Agno] Agentic Chat provides stock price information", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/agno/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await expect(chat.agentGreeting).toBeVisible();

    // Ask for AAPL stock price
    await chat.sendMessage(appleAsk);
    await chat.assertUserMessageVisible(appleAsk);

    // Check if the response contains the expected stock price information
    await chat.assertAgentReplyContains("The current stock price of Apple Inc. (AAPL) is");
  });
});

test("[Agno] Agentic Chat retains memory of previous questions", async ({
  page,
}) => {
  test.slow(); // Multi-message AI conversation: needs extra time
  await retryOnAIFailure(async () => {
    await page.goto(
      "/agno/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await expect(chat.agentGreeting).toBeVisible();

    // First question — use a simple, deterministic question (no external API)
    await chat.sendMessage("What is the capital of France?");
    await chat.assertUserMessageVisible("What is the capital of France?");
    await chat.assertAgentReplyVisible(/Paris/i);

    // Ask about the first question to test memory
    await chat.sendMessage("What was my first question?");
    await chat.assertUserMessageVisible("What was my first question?");

    // Check if the agent remembers the first question about France
    await chat.assertAgentReplyVisible(/France|capital|Paris/i);
  });
});

test("[Agno] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
}) => {
  test.slow(); // Multi-message AI conversation: needs extra time
  await retryOnAIFailure(async () => {
    await page.goto(
      "/agno/feature/agentic_chat"
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