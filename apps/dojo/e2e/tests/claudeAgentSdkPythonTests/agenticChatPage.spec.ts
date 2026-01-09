import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../pages/claudeAgentSdkPythonPages/AgenticChatPage";

test("[Claude Agent SDK Python] Agentic Chat sends and receives a greeting message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/claude-agent-sdk-python/feature/agentic_chat");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible", timeout: 10000 });
    await chat.sendMessage("Hi");

    await waitForAIResponse(page);
    await chat.assertUserMessageVisible("Hi");
    await chat.assertAgentReplyVisible(/Hello|Hi|hey/i);
  });
});

test("[Claude Agent SDK Python] Agentic Chat retains memory of previous questions", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/claude-agent-sdk-python/feature/agentic_chat");

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    // First question
    await chat.sendMessage("Hi, my name is Alex");
    await chat.assertUserMessageVisible("Hi, my name is Alex");
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/Hello|Hi|Alex/i);

    // Ask about the first question to test memory
    await chat.sendMessage("What is my name?");
    await chat.assertUserMessageVisible("What is my name?");
    await waitForAIResponse(page);

    // Check if the agent remembers the name
    await chat.assertAgentReplyVisible(/Alex/i);
  });
});

test("[Claude Agent SDK Python] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/claude-agent-sdk-python/feature/agentic_chat");

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.click();

    await chat.sendMessage("Hey there");
    await chat.assertUserMessageVisible("Hey there");
    await waitForAIResponse(page);
    // Agent should respond with some greeting - don't assert specific wording
    await page.waitForTimeout(2000); // Delay between messages

    const favFruit = "Mango";
    await chat.sendMessage(`My favorite fruit is ${favFruit}`);
    await chat.assertUserMessageVisible(`My favorite fruit is ${favFruit}`);
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));
    await page.waitForTimeout(2000); // Delay between messages

    await chat.sendMessage("and I love listening to Kaavish");
    await chat.assertUserMessageVisible("and I love listening to Kaavish");
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/Kaavish/i);
    await page.waitForTimeout(2000); // Delay between messages

    await chat.sendMessage("tell me an interesting fact about Moon");
    await chat.assertUserMessageVisible("tell me an interesting fact about Moon");
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/Moon/i);
    await page.waitForTimeout(2000); // Delay between messages

    await chat.sendMessage("Can you remind me what my favorite fruit is?");
    await chat.assertUserMessageVisible(
      "Can you remind me what my favorite fruit is?"
    );
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));
  });
});
