import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Cloudflare] Agentic Chat sends and receives a greeting message", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/agentic_chat");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });
    await chat.sendMessage("Hi");

    await waitForAIResponse(page);
    await chat.assertUserMessageVisible("Hi");
    await chat.assertAgentReplyVisible(/Hello|Hi|hey/i);
  });
});

test("[Cloudflare] Agentic Chat responds to questions", async ({ page }) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/agentic_chat");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    await chat.sendMessage("What is 2+2?");
    await chat.assertUserMessageVisible("What is 2+2?");
    await waitForAIResponse(page);

    await chat.assertAgentReplyVisible(/4|four/i);
  });
});

test("[Cloudflare] Agentic Chat retains conversation context", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/agentic_chat");

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    // First message
    await chat.sendMessage("My name is Alice");
    await chat.assertUserMessageVisible("My name is Alice");
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/Alice/i);

    // Check if agent remembers
    await chat.sendMessage("What is my name?");
    await chat.assertUserMessageVisible("What is my name?");
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/Alice/i);
  });
});
